import { runChatGptJson } from '../ai/chatgpt.js';
import { logger } from '../lib/events.js';

/**
 * 주제의 "모양"을 정하는 모듈.
 *
 * 정보성 글 품질 규칙은 "각 항목마다 상세 설명 / 자격 요건 / 활용 분야 /
 * 장단점 / 준비 팁을 구체적으로 쓸 것" 을 요구한다. 그래서 항목이 몇 개냐에 따라
 * 글의 구조를 다르게 잡아야 한다.
 *
 *   - TOP 5, 7가지 처럼 항목이 적으면  → 항목마다 H2 섹션 하나 + H3 세부 소제목 (items)
 *   - TOP 50, 100가지 처럼 많으면       → 큰 표 하나 + 대표 항목만 상세 (table)
 *   - 개수가 없는 일반 정보성 주제        → 소제목 중심 (general)
 *
 * 표를 100행 받는 일은 한 번의 호출로 안 된다. 모델이 "이하 생략" 하거나
 * 출력 길이에 걸려 잘리기 때문에 구간을 나눠 받아 이어 붙이고,
 * 빠진 순위가 있으면 그 구간만 다시 받는다.
 */

/** 이 개수까지는 항목마다 상세 섹션을 쓴다. 넘어가면 글이 감당이 안 된다. */
export const ITEM_LIMIT = 12;

/** 표 행만 나눠 받을 때 한 번에 요청하는 행 수. */
const CHUNK_SIZE = 50;
export const MAX_COUNT = 300;

/** 빠진 행을 다시 채우는 횟수. 100행짜리는 한 번에 안 채워지는 일이 잦다. */
const FILL_PASSES = 2;

/** 표 행만 뽑는 호출에는 블로그 작법 지시가 필요 없다. 짧을수록 싸고 빠르다. */
const ROW_SYSTEM = '표 데이터를 JSON 으로만 출력합니다. 설명을 붙이지 않습니다. '
  + '확인된 자료가 없어도 거절하지 않고 알려진 범위와 추정으로 채웁니다.';

/**
 * 표를 채우다 거절당했을 때 되물을 말.
 *
 * "공식 순위가 없어서 순위를 매길 수 없습니다" 가 가장 흔한 거절이다.
 * 애초에 공식 순위를 요구한 적이 없다는 것을 분명히 해주면 대개 풀린다.
 */
const ROW_INSIST = [
  '[다시 요청합니다 — 거절하지 말고 표를 채워 주세요]',
  '공식 순위표를 만들라는 요청이 아닙니다. 아래 기준을 하나 정해',
  '널리 알려진 정보와 합리적인 추정으로 **줄을 세운 참고용 표**를 만드는 일입니다.',
  '',
  '- "공식 순위가 없다", "정확한 자료가 없다" 는 이유로 비워 두지 마세요.',
  '- 순서에 확신이 없어도 괜찮습니다. 기준을 하나 잡고 그대로 끝까지 줄을 세우세요.',
  '- 각 칸은 널리 알려진 특징으로 채우고, 구체적인 조사 수치는 지어내지 마세요.',
  '',
  '설명 없이 {"rows": [...]} 형태의 JSON 객체 하나만 출력하세요.',
].join('\n');

/** 전수 조사 호출. 있는 것을 다 찾는 일이라 검색을 켜고 돈다. */
const ROSTER_SYSTEM = '주어진 범주에 실제로 속하는 대상을 빠짐없이 찾아 JSON 으로만 출력합니다. '
  + '개수를 채우려고 없는 대상을 지어내지 않습니다.';

/** 전수 조사를 몇 번까지 이어서 물어볼지. 한 번에 다 안 나온다. */
const ROSTER_PASSES = 4;

/**
 * "순위" 성격이 뚜렷한 말. 개수를 안 썼어도 큰 순위표를 기대하는 주제다.
 * (추천/비교는 여기 넣지 않는다. 그건 항목 몇 개를 깊게 다루는 글이다)
 */
const STRONG_RANK = /(순위|랭킹|랭크|서열|ranking\b|top\s*-?\s*\d|베스트|best\s*\d)/i;

/** "추천/비교" 성격. 항목 몇 개를 상세하게 다루는 글이 어울린다. */
const SOFT_RANK = /(추천|고르는|비교|골라|모음)/;

/** 주제 문자열에서 "몇 개짜리 글인지" 알아낸다. */
export function detectCount(topic) {
  const text = String(topic || '');
  const patterns = [
    /top\s*-?\s*(\d{1,3})/i,
    /best\s*-?\s*(\d{1,3})/i,
    /베스트\s*(\d{1,3})/,
    /(\d{1,3})\s*(?:위|가지|개|선|종|곳|대|강)\b/,
    /(\d{1,3})\s*(?:위|가지|개|선|종|곳|대|강)/,
  ];
  for (const pattern of patterns) {
    const matched = text.match(pattern);
    if (matched) {
      const parsed = Number(matched[1]);
      if (Number.isFinite(parsed) && parsed >= 2 && parsed <= MAX_COUNT) return parsed;
    }
  }
  return null;
}

/**
 * 글의 모양을 정한다.
 *
 * "전국 대학 순위" 처럼 개수를 안 쓴 순위 주제가 문제였다. 예전에는 항목 5개짜리
 * 글로 잡혀서, 정작 원하는 "많이 담긴 순위표" 가 안 나왔다. 이제 그런 주제는
 * 설정한 목표 개수(기본 100)짜리 큰 표로 간다.
 *
 * @param {number} [targetCount]  개수를 안 쓴 순위 주제에 쓸 목표 행 수
 * @returns {{shape: 'items'|'table'|'general', count: number|null, needsChunking: boolean}}
 */
export function detectShape(topic, targetCount = 100) {
  const text = String(topic || '');
  const count = detectCount(text);
  const target = Math.min(MAX_COUNT, Math.max(2, Number(targetCount) || 100));

  if (count) {
    return count <= ITEM_LIMIT
      ? { shape: 'items', count, needsChunking: false }
      : { shape: 'table', count, needsChunking: true };
  }

  // 개수를 안 썼지만 "순위" 성격이면 목표 개수만큼 크게 뽑는다.
  if (STRONG_RANK.test(text)) {
    return target <= ITEM_LIMIT
      ? { shape: 'items', count: target, needsChunking: false }
      : { shape: 'table', count: target, needsChunking: true };
  }

  // "추천/비교" 는 항목 몇 개를 깊게. 개수는 AI 가 정한다.
  if (SOFT_RANK.test(text)) return { shape: 'items', count: null, needsChunking: false };

  return { shape: 'general', count: null, needsChunking: false };
}

/* ------------------------------------------------------------------ */
/* 전수 조사 — 대상이 실제로 몇 개 있는지부터 센다                        */
/* ------------------------------------------------------------------ */

/**
 * "2026 전문대 순위 TOP 50" 같은 주제에서 가장 흔한 사고는 이것이다.
 *
 *   - 전문대가 130곳 있는데 모델이 아는 12곳만 쓰고 "이하 생략" 한다
 *   - 반대로 26곳밖에 없는 범주에 50줄을 채우라고 하면 **없는 이름을 지어낸다**
 *
 * 둘 다 글을 버리게 만든다. 그래서 표를 채우기 **전에** 범주에 속한 대상을
 * 먼저 전수 조사한다. 그리고 그 결과로 표의 행 수를 정한다.
 *
 *   - 요청보다 많이 있으면  → 요청한 수(50)까지만 줄을 세운다
 *   - 요청보다 적게 있으면  → 있는 것(26) 전부로 줄을 세운다. 지어내지 않는다.
 *
 * 공식 순위가 없는 범주가 대부분이라, 무엇을 기준으로 줄을 세울지도 함께 받는다.
 * 기준 없이 "순위" 를 요구하면 모델이 매번 다른 잣대로 섞어서 표가 뒤죽박죽이 된다.
 */
export function buildRosterPrompt(topic, want, known = [], pass = 1) {
  const left = Math.max(0, want - known.length);
  const tail = known.slice(-120);

  return `주제: "${topic}"

이 주제가 가리키는 **대상 전체**를 빠짐없이 찾아 주세요.
예를 들어 "전국 전문대 순위" 라면 전국의 전문대를 한 곳도 빼지 말고 다 찾는 일입니다.

규칙
- 목표는 ${want}개입니다. 그보다 많이 존재하면 ${want}개까지만 주세요.
- **${want}개보다 적게 존재한다면 있는 것만 주세요.** 숫자를 채우려고 없는 대상을 지어내면 절대 안 됩니다.
- 실제로 존재하는 고유명사만 쓰세요. "기타", "그 외", "여러 곳" 같은 묶음은 넣지 마세요.
- 같은 대상을 다른 이름으로 두 번 쓰지 마세요. (약칭과 정식 명칭 중 하나만)
- 이번에는 ${left || want}개까지 새로 찾아 주세요.${
  tail.length ? `\n- 이미 받은 ${known.length}개는 전부 빼고 주세요: ${tail.join(', ')}` : ''
}
- rankBasis: 이 대상들을 줄 세울 기준을 하나 정해 한 줄로 적으세요.
  공식 순위가 없으면 널리 쓰이는 대리 지표(규모, 인지도, 취업률, 정원, 설립연도 등)를 골라 그것을 적으세요.
  "기준 없음" 이라고 답하지 마세요. 어떤 기준이든 하나는 정해야 줄을 세울 수 있습니다.
- total: 이 범주에 실제로 존재하는 대상의 전체 개수. 정확히 모르면 짐작값을 적고 totalConfident 를 false 로 두세요.
- exhausted: 더 찾아도 이 범주에 남은 대상이 **없을 때만** true. 아직 더 있으면 false.
${pass > 1 ? '- 앞 차례에서 못 찾은 대상을 찾는 중입니다. 지역과 분야를 바꿔가며 더 넓게 훑으세요.\n' : ''}
JSON 만 출력:
{"names": ["실제 이름1", "실제 이름2"], "total": 130, "totalConfident": true, "exhausted": false, "rankBasis": "재학생 규모와 취업률", "note": "한 줄 메모"}`;
}

/** 같은 대상을 두 번 세지 않기 위한 열쇠. */
export function rosterKey(name) {
  return String(name || '')
    .replace(/\s+/g, '')
    .replace(/[()[\]{}·,.\-–—/]/g, '')
    .toLowerCase();
}

/** 전수 조사 응답을 쓸 수 있는 모양으로 정리한다. */
export function normalizeRoster(data) {
  const names = [];
  const seen = new Set();
  for (const raw of Array.isArray(data?.names) ? data.names : []) {
    const name = String(raw ?? '').trim().replace(/^\d+[.)]\s*/, '').slice(0, 60);
    if (!name) continue;
    // "기타", "그 외" 같은 묶음은 한 줄을 차지하면 안 된다.
    if (/^(기타|그 외|그외|나머지|등|others?|etc\.?)$/i.test(name)) continue;
    const key = rosterKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  const total = Number(data?.total);
  return {
    names,
    total: Number.isFinite(total) && total > 0 ? Math.round(total) : null,
    totalConfident: data?.totalConfident === true,
    exhausted: data?.exhausted === true,
    rankBasis: String(data?.rankBasis ?? '').trim().slice(0, 120),
    note: String(data?.note ?? '').trim().slice(0, 200),
  };
}

/**
 * 전수 조사 결과로 표의 행 수를 정한다.
 *
 * 요청한 수보다 **적게 존재한다고 확인됐을 때만** 줄인다. 확인이 안 됐으면
 * 요청한 수를 그대로 쓴다. 어설픈 짐작으로 줄이면 있는데도 안 쓰는 표가 된다.
 */
export function decideRowCount(want, roster) {
  const target = Math.max(1, Math.min(MAX_COUNT, Number(want) || 0));
  const found = roster?.names?.length || 0;
  const total = Number(roster?.total);

  // 더 이상 없다고 다 훑은 결과다. 있는 것 전부로 줄을 세운다.
  if (roster?.exhausted && found > 0 && found < target) return found;

  // 아직 다 못 훑었지만 "이 범주는 원래 이만큼뿐" 이라고 확신하는 경우.
  // 찾아온 이름보다 적게 잡으면 받아온 것을 버리게 되므로 둘 중 큰 쪽을 쓴다.
  if (roster?.totalConfident && Number.isFinite(total) && total > 0 && total < target) {
    return Math.max(1, Math.min(target, Math.max(found, total)));
  }

  return target;
}

/**
 * 범주에 속한 대상을 여러 번에 걸쳐 모은다.
 *
 * 한 번에 50개를 달라고 하면 모델이 20개쯤에서 멈춘다. 그래서 받은 것을
 * 알려주면서 "이건 빼고 더" 를 반복한다. 한 바퀴 돌았는데 하나도 늘지 않으면
 * 더 물어봐야 같으므로 멈춘다.
 *
 * 조사가 실패해도 **던지지 않는다.** 전수 조사는 표를 더 정확하게 만드는
 * 보조 장치일 뿐이어서, 실패하면 예전처럼 요청한 수만큼 그냥 채우면 된다.
 * 여기서 던지면 조사 한 번 어긋났다고 글 한 편이 통째로 날아간다.
 *
 * @returns {Promise<{names, total, totalConfident, exhausted, rankBasis, note, passes, failed}>}
 */
export async function collectRoster(topic, want, { signal } = {}) {
  const merged = {
    names: [], total: null, totalConfident: false, exhausted: false,
    rankBasis: '', note: '', passes: 0, failed: '',
  };
  const seen = new Set();

  for (let pass = 1; pass <= ROSTER_PASSES; pass += 1) {
    let reply;
    try {
      reply = await runChatGptJson(
        buildRosterPrompt(topic, want, merged.names, pass),
        {
          systemPrompt: ROSTER_SYSTEM,
          web: true,
          signal,
          // 전수 조사도 "확인할 자료가 없다" 며 거절하는 일이 있다.
          // 빈손으로 끝나면 표가 통째로 부실해지므로 한 번 되묻는다.
          insist: '[다시 요청합니다] 공식 전수 명단이 없어도 괜찮습니다. '
            + '널리 알려진 것만이라도 최대한 많이 모아 주세요. 빈손으로 돌려주지 마시고, '
            + '확신이 서지 않으면 totalConfident 를 false 로 두면 됩니다. '
            + '설명 없이 JSON 객체 하나만 출력하세요.',
        },
      );
    } catch (error) {
      // 중지·로그인 만료·한도는 계속 돌려봐야 같다. 그대로 올린다.
      if (error?.rateLimited || error?.authExpired || /중지했습니다/.test(error?.message || '')) {
        throw error;
      }
      merged.failed = String(error.message).split('\n')[0];
      logger.warn(
        `[${topic}] 전수 조사 ${pass}차가 실패했습니다: ${merged.failed}`
        + (merged.names.length ? ' — 지금까지 찾은 것으로 이어갑니다.' : ' — 요청한 개수로 그냥 채웁니다.'),
      );
      break;
    }

    merged.passes = pass;
    const chunk = normalizeRoster(reply.data);

    let added = 0;
    for (const name of chunk.names) {
      const key = rosterKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.names.push(name);
      added += 1;
    }

    if (chunk.rankBasis && !merged.rankBasis) merged.rankBasis = chunk.rankBasis;
    if (chunk.note && !merged.note) merged.note = chunk.note;
    // 전체 개수는 가장 확신하는 답을 쓴다.
    if (chunk.total && (!merged.total || (chunk.totalConfident && !merged.totalConfident))) {
      merged.total = chunk.total;
      merged.totalConfident = chunk.totalConfident;
    }
    if (chunk.exhausted) merged.exhausted = true;

    logger.info(
      `[${topic}] 전수 조사 ${pass}차 — 새로 ${added}개 (누적 ${merged.names.length}개`
      + `${merged.total ? ` / 전체 약 ${merged.total}개` : ''}${chunk.exhausted ? ', 더 없음' : ''})`,
    );

    // 목표를 채웠거나, 더 없다고 했거나, 한 바퀴 돌아 하나도 못 늘었으면 끝.
    if (merged.names.length >= want || chunk.exhausted || !added) break;
  }

  return merged;
}

function normalizeRows(rawRows, columnCount) {
  if (!Array.isArray(rawRows)) return [];
  return rawRows
    .map((row) => {
      if (Array.isArray(row)) return row.map((cell) => String(cell ?? '').trim());
      if (row && typeof row === 'object') return Object.values(row).map((cell) => String(cell ?? '').trim());
      return null;
    })
    .filter(Boolean)
    .map((cells) => {
      const fixed = cells.slice(0, columnCount);
      while (fixed.length < columnCount) fixed.push('');
      return fixed;
    })
    .filter((cells) => cells.some((cell) => cell));
}

/** 행의 첫 칸에서 순위 숫자를 뽑는다. "1위", "1." 같은 표기도 허용. */
function rankOf(row) {
  const matched = String(row?.[0] ?? '').match(/\d+/);
  return matched ? Number(matched[0]) : null;
}

/**
 * 뒤 구간으로 갈수록 "더 넓게 보라"고 일러준다.
 *
 * 큰 순위표가 실패하는 지점은 늘 뒤쪽이다. 상위권은 누구나 아는 이름으로
 * 금방 채우지만, 50번을 넘어가면 모델이 앞에서 쓴 이름을 다시 쓰거나
 * "이하 생략" 하고 멈춘다. 그래서 구간마다 어디까지 넓혀야 하는지
 * 명시적으로 알려준다. 이것이 100행을 실제로 채우는 핵심이다.
 */
function broadenHint(start, count) {
  const ratio = start / Math.max(1, count);
  if (ratio < 0.25) return '';
  if (ratio < 0.5) {
    return '- 이 구간부터는 상위권에서 이미 다 나왔습니다. '
      + '수도권 밖과 중견 규모까지 범위를 넓혀서 채우세요.';
  }
  if (ratio < 0.75) {
    return '- 이 구간은 **지방과 덜 알려진 곳**까지 넓혀야 채워집니다. '
      + '광역시와 각 도 단위로 고르게 훑으면서 빠짐없이 찾으세요.';
  }
  return '- 이 구간은 **전국을 통틀어 규모가 작거나 특수 목적인 곳**까지 포함해야 합니다. '
    + '지역별로 남은 곳, 전문 분야에 특화된 곳을 찾아서라도 반드시 끝까지 채우세요. '
    + '"더 이상 없습니다" 라고 답하지 말고, 범위를 넓혀 끝까지 채우세요.';
}

export function buildChunkPrompt({
  topic, headers, start, end, existingNames, count, roster, rankBasis,
}) {
  const expected = end - start + 1;
  // 예시 행은 반드시 실제 열 개수와 같아야 한다.
  // 3칸짜리 예시를 고정으로 보여주면 열이 4개여도 3칸만 채워서 돌려준다.
  const sampleRow = (rank) => JSON.stringify(
    [String(rank), ...headers.slice(1).map((header) => `${header} 내용`)],
  );

  /*
   * 전수 조사에서 "이게 전부다" 를 확인했으면 범위를 넓히라고 하면 안 된다.
   * 더 없는데 넓히라고 하면 모델이 없는 이름을 지어내서 채운다. 그게 제일 나쁘다.
   */
  const exhaustive = Boolean(roster?.exhausted) && (roster?.names?.length || 0) >= count;
  const broaden = exhaustive ? '' : broadenHint(start, count);

  // 조사해둔 이름 중 아직 표에 안 들어간 것만 보여준다. 이 안에서 고르게 한다.
  const pool = (roster?.names || []).filter((name) => !existingNames.some(
    (used) => rosterKey(used) === rosterKey(name),
  ));

  const lines = [
    `주제: "${topic}"`,
    `이 주제의 표는 전체 ${count}개 행짜리입니다.`,
    `그중 ${start}~${end}번, 정확히 ${expected}개 행을 채우세요.`,
    '',
    `열: ${headers.join(' | ')}`,
    '',
    '규칙',
    `- ${expected}개 행 전부 출력. "이하 생략", "...", "(중략)" 금지.`,
    `- 첫 칸은 번호 숫자만 (${start}~${end}).`,
    `- 각 행은 정확히 ${headers.length}칸, 빈 칸 없이.`,
    '- 각 칸 24자 이내. 특수문자와 이모지는 쓰지 마세요.',
    '- 앞에 나온 항목을 다시 쓰지 마세요. 전부 새로운 항목이어야 합니다.',
    '- 공식 조사 결과가 아니라 널리 알려진 정보를 모은 참고용 표입니다. '
      + '실제 조사 수치는 지어내지 말고 일반적인 특징으로 채우세요.',
  ];

  // 무엇을 기준으로 줄을 세우는지 못박는다. 이게 없으면 구간마다 잣대가 달라진다.
  lines.push(
    `- 줄을 세우는 기준: ${rankBasis || '규모와 인지도처럼 널리 쓰이는 대리 지표'}. `
    + '구간이 바뀌어도 같은 기준을 쓰세요. 기준이 애매해도 순위를 비우지 말고 '
    + '이 기준으로 끝까지 줄을 세우세요.',
  );

  if (pool.length) {
    lines.push(
      `- 아래는 미리 조사해둔 실제 목록입니다. **이 안에서만** 골라 채우세요 `
      + `(${pool.length}개): ${pool.slice(0, 160).join(', ')}`,
    );
  }
  if (exhaustive) {
    lines.push(
      '- 이 범주에는 위 목록이 전부입니다. 목록에 없는 이름을 새로 지어내면 안 됩니다. '
      + '모자라면 비워 두는 편이 낫습니다.',
    );
  }
  if (broaden) lines.push(broaden);
  if (existingNames.length) {
    lines.push(`- 이미 나온 항목 ${existingNames.length}개 (전부 제외): ${existingNames.slice(-90).join(', ')}`);
  }

  lines.push('', 'JSON 만 출력:', `{"rows": [${sampleRow(start)}, ${sampleRow(start + 1)}]}`);
  return lines.join('\n');
}

/**
 * 큰 표를 구간별로 나눠 받아 하나로 이어 붙인다.
 * 빠진 구간은 한 번 더 요청해서 메운다.
 */
export async function generateTableRows({
  topic,
  headers,
  count,
  signal,
  onProgress,
  roster,
  rankBasis,
}) {
  const columnCount = headers.length;
  const byRank = new Map();
  let model = '';

  // 이름이 같은 항목이 뒤 구간에서 다시 나오면 버린다.
  // 100행짜리에서 이게 없으면 "서울대"가 3번 들어간 표가 나온다.
  const usedNames = new Set();
  const nameKey = (row) => rosterKey(row[1]);

  const fetchRange = async (start, end) => {
    const existingNames = [...byRank.values()].map((row) => row[1]).filter(Boolean);
    const prompt = buildChunkPrompt({
      topic, headers, start, end, existingNames, count, roster, rankBasis,
    });
    const reply = await runChatGptJson(prompt, {
      systemPrompt: ROW_SYSTEM, signal, insist: ROW_INSIST,
    });
    model = reply.model || model;

    let added = 0;
    let duplicates = 0;
    for (const row of normalizeRows(reply.data?.rows, columnCount)) {
      const rank = rankOf(row);
      // 범위 밖이거나 번호를 못 읽은 행은 버린다. 순서가 꼬이는 것보다 낫다.
      if (rank === null || rank < 1 || rank > count) continue;
      if (byRank.has(rank)) continue;

      const key = nameKey(row);
      if (key && usedNames.has(key)) { duplicates += 1; continue; }
      if (key) usedNames.add(key);

      row[0] = String(rank);
      byRank.set(rank, row);
      added += 1;
    }
    return { added, duplicates };
  };

  for (let start = 1; start <= count; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE - 1, count);
    const { duplicates } = await fetchRange(start, end);
    onProgress?.({ filled: byRank.size, total: count });
    logger.info(
      `비교표 ${start}~${end}번 생성 (누적 ${byRank.size}/${count}개`
      + `${duplicates ? `, 중복 ${duplicates}건 제외` : ''})`,
    );
  }

  /** 빠진 번호를 연속 구간으로 묶는다. */
  const missingRanges = () => {
    const missing = [];
    for (let rank = 1; rank <= count; rank += 1) {
      if (!byRank.has(rank)) missing.push(rank);
    }
    if (!missing.length) return [];
    const ranges = [];
    let head = missing[0];
    let prev = missing[0];
    for (const rank of missing.slice(1)) {
      if (rank === prev + 1) { prev = rank; continue; }
      ranges.push([head, prev]);
      head = rank;
      prev = rank;
    }
    ranges.push([head, prev]);
    return ranges;
  };

  // 100행짜리는 한 번 훑어서 다 안 채워진다. 채워질 때까지 몇 번 더 돈다.
  for (let pass = 1; pass <= FILL_PASSES; pass += 1) {
    const ranges = missingRanges();
    if (!ranges.length) break;

    const empty = ranges.reduce((total, [start, end]) => total + (end - start + 1), 0);
    logger.warn(`${empty}개 행이 비어 다시 채웁니다. (${pass}/${FILL_PASSES}차 시도)`);

    let gained = 0;
    for (const [start, end] of ranges) {
      try {
        const { added } = await fetchRange(start, end);
        gained += added;
      } catch (error) {
        logger.warn(`${start}~${end}번 재생성 실패: ${error.message}`);
      }
    }
    onProgress?.({ filled: byRank.size, total: count });

    // 한 바퀴 돌았는데 한 줄도 못 늘었다면 더 돌려도 같다. 호출만 버린다.
    if (!gained) {
      logger.warn('더 채워지지 않아 남은 시도를 건너뜁니다.');
      break;
    }
  }

  const rows = [];
  const stillMissing = [];
  for (let rank = 1; rank <= count; rank += 1) {
    const row = byRank.get(rank);
    if (row) rows.push(row);
    else stillMissing.push(rank);
  }

  /*
   * 끝내 못 채운 번호가 있으면 **번호를 다시 매긴다.**
   *
   * 50줄을 노렸는데 31줄만 채워졌다고 하자. 그대로 두면 표가
   *
   *     1위  ...      4위  ...      9위  ...     ← 2,3,5,6,7,8 이 통째로 빈다
   *
   * 처럼 나온다. 독자 눈에는 글이 잘못 만들어진 것으로만 보인다.
   * 빠진 번호가 무엇이었는지는 독자에게 아무 의미가 없고, 우리에게만 의미가 있다.
   *
   * 그래서 화면에 나가는 표는 **1위부터 끊김 없이** 다시 번호를 매긴다.
   * 순서(줄을 세운 결과)는 그대로 두고 번호만 당긴다. 몇 개를 못 채웠는지는
   * missing 으로 올려보내 표 아래 안내와 로그에 쓴다.
   */
  let renumbered = 0;
  if (stillMissing.length && rows.length) {
    rows.forEach((row, index) => {
      const wanted = String(index + 1);
      if (row[0] !== wanted) renumbered += 1;
      row[0] = wanted;
    });
    logger.info(
      `못 채운 번호가 있어 ${rows.length}개 행을 1위부터 다시 번호 매겼습니다. `
      + '(번호가 중간에 비어 있는 표보다 낫습니다)',
    );
  }

  // 열을 통째로 비워서 돌려주는 경우가 있어 채움 상태를 짚어둔다.
  const emptyCells = rows.reduce(
    (total, row) => total + row.filter((cell) => !cell).length,
    0,
  );
  if (emptyCells > rows.length * 0.2) {
    logger.warn(`표에 빈 칸이 ${emptyCells}개 있습니다. 열 구성이 복잡하면 줄이는 편이 낫습니다.`);
  }

  return { rows, model, missing: stillMissing, emptyCells, renumbered };
}
