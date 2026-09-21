import { runChatGptJson } from '../ai/chatgpt.js';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';
import { normalizeTag } from '../lib/util.js';
import { buildExampleBlock } from './examples.js';
import {
  detectShape, generateTableRows, collectRoster, decideRowCount, ITEM_LIMIT,
} from './ranking.js';
import { runResearch, buildResearchBlock } from './research.js';
import {
  buildRuleBlock, buildRepairBlock, checkCompliance, countChars, summarize,
} from './quality.js';

const BASE_SYSTEM = [
  '당신은 네이버 블로그 정보성 포스팅 전문 에디터이자 전문 카피라이터입니다.',
  '구글 알고리즘이 "고품질의 정보성 글"로 인식할 만큼 깊이 있고 구조화된 한국어 포스팅을 씁니다.',
  '모든 문장은 "~습니다", "~입니다" 형태의 완전한 종결어미로 끝냅니다.',
  '단순 나열 대신 근거와 맥락을 붙입니다.',
  // 거절하지 않게 하는 지시. "지어내지 마라" 만 강하게 걸어두면 확인된 자료가
  // 없을 때 아예 글쓰기를 거부해 버린다. 쓰되 어디까지가 추정인지 밝히게 한다.
  '자료가 부족해도 글쓰기를 거절하지 않습니다. 알려진 범위와 합리적인 추정으로 끝까지 쓰고,'
  + ' 확실하지 않은 부분은 단정하는 대신 추정임을 밝힙니다.',
  '특수문자와 이모지를 쓰지 않고 깔끔한 텍스트로만 씁니다.',
  '요청받은 JSON 형식만 정확히 출력합니다.',
].join(' ');

/**
 * 사용자 지침을 프롬프트 맨 앞에 놓는 블록.
 * 고정 규칙 목록 끝에 한 줄로 붙으면 묻히기 때문에 별도 최상위 섹션으로 올린다.
 *
 * 다만 필수 품질 규칙보다는 아래에 둔다. 이 프로그램의 목적 자체가
 * "검색에 걸리는 정보성 글" 이라서, 규칙을 깨는 지침까지 이기게 하면 프로그램이 무의미해진다.
 */
export function buildGuidelineBlock(guideline) {
  const text = String(guideline || '').trim();
  if (!text) return '';
  return `[사용자 지침 — 반드시 반영할 것]
아래는 사용자가 이 글에 직접 요구한 내용입니다.
일반적인 작성 요령과 충돌하면 이 지침을 우선하세요.
(단, 뒤에 나오는 "필수 준수 규칙"만은 어길 수 없습니다. 둘 다 만족시키세요.)

${text.split('\n').map((line) => (line.trim() ? `- ${line.trim()}` : '')).filter(Boolean).join('\n')}

============================================================

`;
}

/**
 * 제목을 사용자가 정해 준 경우의 지시.
 *
 * 프롬프트 **맨 앞**에 놓는다. 뒤쪽에 한 줄로 붙이면 모델이 "더 좋은 제목" 을
 * 지어내서 바꿔 버린다. 그리고 코드에서도 한 번 더 강제로 덮어쓴다.
 * (generatePost 끝부분 참고) 프롬프트만으로는 글자 하나까지 지켜지지 않는다.
 */
export function buildFixedTitleBlock(fixedTitle) {
  const title = String(fixedTitle || '').trim();
  if (!title) return '';
  return `[글 제목 — 이미 정해졌습니다. 바꾸지 마세요]
이 글의 제목은 아래 한 줄입니다.

${title}

- title 필드에 위 문장을 **글자 하나도 바꾸지 않고** 그대로 넣으세요.
- 더 좋은 제목을 지어내지 마세요. 줄이거나 늘이거나 맞춤법을 고치지도 마세요.
- 제목에 든 숫자(TOP 50 등), 물음표, 따옴표, 기호도 그대로 두세요.
- **본문은 이 제목이 약속한 내용을 지키도록 쓰세요.** 제목이 "TOP 50" 이라면
  50개를 다루고, 제목이 질문이라면 본문에서 그 질문에 답해야 합니다.
  제목과 본문이 어긋나면 독자가 속았다고 느낍니다.

============================================================

`;
}

/** 프롬프트 맨 끝에서 한 번 더 짚어준다. 마지막에 읽은 지시를 더 잘 따른다. */
function buildGuidelineReminder(guideline) {
  const text = String(guideline || '').trim();
  if (!text) return '';
  return `

============================================================
[마지막 확인 — 사용자 지침을 지켰습니까?]
${text}

출력하기 전에 위 지침을 하나씩 다시 확인하세요.
지키지 못한 항목이 있으면 고쳐서 출력하고, guidelineCheck 필드에
각 지침을 어떻게 반영했는지 한 줄로 적으세요.`;
}

function buildSystemPrompt(guideline) {
  const text = String(guideline || '').trim();
  if (!text) return BASE_SYSTEM;
  return (
    `${BASE_SYSTEM} 사용자가 직접 준 지침이 있으면 그것을 반영하되, ` +
    `필수 준수 규칙은 어떤 경우에도 지킵니다. ` +
    `이번 사용자 지침: ${text.replace(/\s+/g, ' ').slice(0, 500)}`
  );
}

/* ------------------------------------------------------------------ */
/* 프롬프트 조각                                                        */
/* ------------------------------------------------------------------ */

function basicsBlock(settings, topic) {
  const { tone, audience, sectionCount, minChars } = settings.post;
  return [
    '[포스팅 기본 정보]',
    `- 주제: ${topic}`,
    `- 타겟 독자: ${audience}`,
    `- 어조: ${tone}`,
    `- 목표 분량: 공백 제외 ${minChars.toLocaleString()}자 이상 (넘겨도 좋습니다)`,
    `- H2 소제목: ${sectionCount}개 내외`,
  ].join('\n');
}

const THUMBNAIL_BLOCK = `[썸네일]
썸네일은 이미지 생성 AI 가 **글자까지 통째로 그립니다.** 그래서 그림 안에 들어갈
문구를 정확히 정해 주셔야 합니다. 짧고 굵을수록 잘 나옵니다.

- posterLines: 썸네일에 가장 크게 박힐 제목을 **1~3줄로 끊어서** 배열로. 한 줄 12자 이내.
  클릭하고 싶게 쓰되 낚시는 금물입니다.
  예) ["4년제만 답이 아니다", "취업 최강 전문대"]
- ribbon: 제목 아래 띠에 들어갈 한 줄. 12자 이내. 개수와 연도를 넣으면 좋습니다.
  예) "TOP 50 대공개 (2026 최신)"
- subline: 맨 아래 한 줄 요약. 24자 이내. 예) "실무, 자격증, 현장 경험으로 골랐습니다"
- badge: 구석 뱃지에 들어갈 짧은 말. 6자 이내. 예) "전문대"
- keywords: 아이콘 뱃지에 붙일 짧은 분류어 3~5개. 각 5자 이내.
  예) ["간호보건", "반도체", "자동차", "항공", "IT"]
- scene: 배경 그림으로 그릴 장면을 **영어 한 문장**으로. 주제를 상징하는 공간이나 사물.
  사람 얼굴이 크게 나오는 구도와 상표는 피하세요.
  예) "students in a bright technical college workshop with machines and computers"
- accent: 어두운 계열 HEX / style: bold, gradient, minimal, editorial 중 하나
  (이미지 생성이 꺼져 있을 때 쓰는 값입니다)

썸네일 문구에는 특수문자와 이모지를 쓰지 마세요. 느낌표는 한 개까지 허용합니다.
**본문 규칙과 달리 썸네일 문구는 "~습니다" 로 끝내지 않아도 됩니다.** 짧은 것이 우선입니다.`;

function metaBlock(hasFixedTitle) {
  return `[검색 최적화 필드]
- summary: 검색 결과에 뜰 한 줄 요약 (80~120자, "~습니다" 로 끝낼 것)
- tags: 3~6개. 글 맨 끝에 #태그 로 붙습니다. 네이버 태그에는 공백을 넣을 수 없으니
  "국가기술자격증" 처럼 붙여 쓰고, 사람들이 실제로 검색할 만한 말을 고르세요.
${hasFixedTitle
    ? '- 제목은 이미 정해져 있습니다. 위에 적힌 그대로 쓰고 손대지 마세요.'
    : '- 제목은 검색어가 앞쪽에 오도록 쓰되, 낚시성 표현은 쓰지 마세요.'}`;
}

/** 표를 한 번에 받아도 되는 글용 JSON 형식 안내. */
function jsonShape({ withItems, withFaq, withCriteria, withTableRows, withFixedTitle }) {
  const criteria = withCriteria
    ? `\n  "criteria": {
    "heading": "추천 항목을 고른 세 가지 기준",
    "paragraphs": ["기준을 왜 이렇게 잡았는지 설명하는 완전한 문장 2~3개입니다."],
    "items": ["취업률: 최근 채용 공고 수를 기준으로 삼았습니다.", "활용성: 여러 산업에서 통용되는지를 보았습니다."]
  },`
    : '';

  const table = withTableRows
    ? `\n  "table": {"heading":"한눈에 보는 비교표","headers":["구분","항목","핵심 특징","난이도"],"rows":[["1","항목 이름","특징","보통"]],"note":"표 아래 안내 한 줄입니다."},`
    : `\n  "table": {"heading":"한눈에 보는 비교표","headers":["구분","항목","핵심 특징","난이도"],"note":"표 아래 안내 한 줄입니다."},`;

  const section = withItems
    ? `{
      "heading": "1위. 항목 이름",
      "isItem": true,
      "paragraphs": ["이 항목을 왜 먼저 다루는지 설명하는 문단입니다."],
      "subsections": [
        {"heading":"상세 설명","paragraphs":["..."]},
        {"heading":"자격 요건과 난이도","paragraphs":["..."]},
        {"heading":"실제 활용 분야","paragraphs":["..."], "list":["완전한 문장으로 쓴 항목입니다."]},
        {"heading":"장점과 단점","paragraphs":["..."], "list":["장점을 문장으로 씁니다.","단점도 솔직하게 적습니다."]},
        {"heading":"준비 팁","paragraphs":["..."]}
      ]
    }`
    : `{
      "heading": "소제목",
      "paragraphs": ["문단1","문단2"],
      "list": ["핵심 포인트를 완전한 문장으로 정리합니다."],
      "quote": "",
      "subsections": [{"heading":"세부 소제목","paragraphs":["..."]}]
    }`;

  const faq = withFaq
    ? `\n  "faq": [{"question":"자주 묻는 질문입니다.","answer":"두세 문장으로 답합니다."}],`
    : '';

  return `{
  "title": ${withFixedTitle
    ? '"위에서 정해준 제목을 글자 하나도 바꾸지 않고 그대로"'
    : '"제목 (낚시성 없이 명확하게, 40자 이내)"'},
  "summary": "한 줄 요약입니다.",
  "tags": ["태그1","태그2","태그3"],
  "guidelineCheck": "사용자 지침을 어떻게 반영했는지 한 줄 (지침 없으면 \\"\\")",
  "thumbnail": {"posterLines":["큰 제목 1줄","큰 제목 2줄"],"ribbon":"TOP 50 (2026 최신)","headline":"...","subline":"...","badge":"...","keywords":["분류1","분류2","분류3"],"scene":"english scene description","style":"minimal","accent":"#1F3A93"},
  "intro": ["도입 문단1", "도입 문단2", "도입 문단3"],${criteria}${table}
  "sections": [
    ${section}
  ],${faq}
  "outro": ["글 전체를 요약하는 마무리 문단입니다.", "독자를 격려하는 문단입니다."]
}`;
}

function structureGuide(shape, settings, count) {
  const lines = ['[글의 구조]'];
  lines.push('- intro: 독자의 문제 상황에 공감하는 도입부 2~3문단. 인사말 없이 바로 본론으로 들어가세요.');
  if (settings.post.addCriteria) {
    lines.push('- criteria: 어떤 기준으로 골랐는지 밝히는 단락. 이 글의 신뢰도를 만드는 부분이라 반드시 채웁니다.');
  }
  lines.push('- table: 항목을 한눈에 비교하는 표. 열 3~5개.');

  if (shape === 'items') {
    lines.push(
      `- sections: 항목 ${count ? `${count}개` : `${Math.min(5, settings.post.sectionCount + 1)}개 내외`}를 `
      + '각각 하나의 H2 섹션으로 다룹니다. isItem 을 true 로 두세요.',
    );
    lines.push('- 각 항목 섹션에는 H3 세부 소제목을 최소 3개 넣습니다: '
      + '상세 설명 / 자격 요건과 난이도 / 실제 활용(취업) 분야 / 장점과 단점 / 준비 팁');
    lines.push('- 항목마다 단점과 주의점도 솔직하게 적으세요. 장점만 나열하면 광고성 글로 보입니다.');
  } else if (shape === 'table') {
    lines.push(
      `- 이 글의 표는 ${count}개 행짜리로 꽤 큽니다. 본문은 그 표를 읽는 법을 안내하는 역할입니다.`,
    );
    lines.push('- sections: 표를 읽을 때 주의할 점, 항목을 고르는 기준, '
      + '대표 항목 3~4개의 상세 설명으로 나눕니다.');
    lines.push('- 대표 항목 섹션에는 H3 세부 소제목(상세 설명 / 장단점 / 준비 팁)을 붙이세요.');
    lines.push(
      '- 표의 한계를 반드시 짚으세요. 예를 들어 "24위와 25위가 실제로 한 단계 차이라고 '
      + '받아들이면 안 됩니다" 처럼, 순위를 그대로 믿으면 안 되는 이유를 한 문단 이상 쓰세요.',
    );
  } else {
    lines.push(`- sections: H2 소제목 ${settings.post.sectionCount}개. `
      + '각 섹션에 H3 세부 소제목을 1개 이상 붙여 내용을 나눕니다.');
    lines.push('- 최소 한 섹션에는 불렛 포인트 목록(list)을 넣으세요.');
  }

  if (settings.post.addFaq) {
    lines.push('- faq: 독자가 실제로 궁금해할 질문 3개와 답변. 답변도 "~습니다" 로 끝냅니다.');
  }
  lines.push('- outro: 글 전체 내용을 요약하고 독자를 따뜻하게 독려하는 마무리 2문단.');
  return lines.join('\n');
}

/**
 * 사실관계 지침. 조사 자료가 있느냐에 따라 말이 달라져야 한다.
 *
 * 검색 자료를 붙여 놓고 "너는 검색을 못 하니 수치를 쓰지 마라" 라고 하면
 * 모델이 애써 찾아온 수치를 다 버리고 두루뭉술하게 쓴다. 반대로 자료가
 * 없는데 수치를 쓰라고 하면 지어낸다. 그래서 두 경우를 나눈다.
 */
/**
 * 사실관계를 어떻게 다룰지.
 *
 * 여기서 균형을 잘못 잡으면 두 가지 중 하나가 난다.
 *   느슨하면 → 있지도 않은 제도와 수치를 사실처럼 적는다
 *   빡빡하면 → **아예 글쓰기를 거절한다** ("확인된 자료가 없어 쓸 수 없습니다")
 *
 * 실제로 겪은 것은 두 번째였다. 검색이 빈손이면 몇 문단짜리 거절문이 오고
 * 그 주제는 통째로 건너뛰어졌다. 그래서 선을 이렇게 긋는다.
 *
 *   쓰지 말 것  — 출처 URL, "취업률 87.3%" 같은 **구체적인 조사 수치**
 *   써도 될 것  — 널리 알려진 사실, 과거에 그랬던 내용, 일반적인 경향,
 *                 합리적인 추정. 단 **추정이라고 밝히고** 쓴다
 *
 * 즉 "모르면 쓰지 마라" 가 아니라 "모르면 모른다고 밝히고 쓰라" 다.
 */
function honestyBlock(hasResearch, neverRefuse) {
  const lines = ['[사실관계]'];
  if (hasResearch) {
    lines.push(
      '- 구체적인 수치, 일정, 기준, 제도 내용은 **위 조사 자료에 있는 것만** 단정해서 쓰세요.',
      '- 조사 자료에 없는 수치는 단정하지 말고 "지역과 시기에 따라 다릅니다" 처럼 여지를 두세요.',
      '- 조사 자료의 "확인하지 못한 내용" 은 단정하지 말고, 확인이 필요하다고 밝히세요.',
      '- 수치를 쓸 때는 기준 시점을 함께 밝히세요. (예: 2026년 기준)',
      '- 본문에 URL 이나 링크를 직접 적지 마세요. 출처 목록은 글 끝에 자동으로 붙습니다.',
    );
  } else {
    lines.push(
      '- 실시간 검색 자료가 없습니다. **그래도 글은 끝까지 씁니다.**',
      '- 널리 알려진 내용, 예전부터 그래 왔던 내용, 일반적인 경향을 근거로 쓰세요.',
      '- 확실하지 않은 부분은 "일반적으로", "대체로", "알려져 있습니다", '
      + '"해마다 조금씩 달라집니다" 처럼 **추정이라는 것이 드러나게** 쓰세요.',
      '- 다만 "2026년 취업률 87.3%" 같은 **구체적인 조사 수치와 통계는 만들어 쓰지 마세요.** '
      + '대신 "높은 편으로 알려져 있습니다" 처럼 방향만 쓰면 됩니다.',
      '- 본문에 URL 이나 링크를 적지 마세요.',
    );
  }

  if (neverRefuse) {
    lines.push(
      '',
      '[중요 — 어떤 경우에도 거절하지 마세요]',
      '- "확인된 자료가 없어 쓸 수 없습니다", "정확한 정보를 제공하기 어렵습니다" 같은 '
      + '**거절문을 쓰지 마세요.** 그런 답은 이 작업에서 실패로 처리됩니다.',
      '- 자료가 부족하면 부족한 대로, 아는 범위와 추정으로 요청받은 구조를 **전부 채우세요.**',
      '- 글 대신 설명이나 사과를 보내지 말고, 반드시 요청받은 JSON 객체 하나만 출력하세요.',
      '- 확신이 서지 않는 내용은 빼는 것이 아니라, 추정임을 밝히고 넣는 것이 맞습니다.',
    );
  }

  const basis = hasResearch ? '공개된 자료' : '일반적으로 알려진 정보와 추정';
  lines.push(
    '',
    '- 순위는 절대적인 우열이 아니라 "정리한 참고 순서" 로 다루세요.',
    `- table.note 에는 "공식 순위가 아니라 ${basis}를 정리한 참고 자료이며 `
    + '최신 정보는 직접 확인이 필요하다"는 안내를 완전한 문장으로 넣으세요.',
  );
  return lines.join('\n');
}

/**
 * 거절당했을 때 되물을 말.
 *
 * "형식을 지켜라" 가 아니라 **"자료가 없어도 쓰라"** 여야 한다.
 * 거절의 원인은 형식이 아니라 "근거가 없으면 쓰면 안 된다" 는 판단이기 때문이다.
 */
export const INSIST_BLOCK = [
  '[다시 요청합니다 — 거절하지 말고 반드시 써 주세요]',
  '방금 보내주신 답은 글이 아니라 거절문이었습니다. 이 작업에서는 실패로 처리됩니다.',
  '',
  '확인된 최신 자료가 없어도 괜찮습니다. 아래대로 써 주세요.',
  '- 예전부터 알려져 있던 내용, 일반적인 통념, 합리적인 추정으로 채우세요.',
  '- 확실하지 않은 부분은 빼지 말고, "일반적으로", "대체로", "알려져 있습니다" 처럼',
  '  추정이라는 것이 드러나게 표현해서 **넣으세요.**',
  '- 구체적인 조사 수치와 통계(예: "취업률 87.3%")만 만들어 쓰지 마시고,',
  '  "높은 편으로 알려져 있습니다" 처럼 방향만 적으면 됩니다.',
  '- 출처 URL 은 적지 마세요.',
  '',
  '설명이나 사과 없이, 요청받은 JSON 객체 하나만 출력하세요.',
].join('\n');

const FORMAT_BLOCK = [
  '[서식]',
  '- 문단 안에서 핵심 표현 한둘만 <b>강조</b>로 감쌀 수 있습니다. 그 외 HTML 태그는 쓰지 마세요.',
  '- 마크다운 기호(#, *, -, |)를 문자열 안에 직접 넣지 마세요. 구조는 JSON 필드로만 표현합니다.',
  '- 목록 항목과 표 칸도 특수문자 없이 씁니다.',
].join('\n');

/* ------------------------------------------------------------------ */
/* 프롬프트 조립                                                        */
/* ------------------------------------------------------------------ */

/**
 * 표 아래에 붙는 한 줄.
 *
 * 순위를 무엇으로 매겼는지, 그리고 **요청한 개수보다 적으면 왜 적은지**를
 * 반드시 밝힌다. "TOP 50" 을 기대하고 들어온 독자가 26줄을 보면 글이 부실한
 * 것처럼 읽히는데, 사실은 전국에 26곳뿐이라 다 담은 것이기 때문이다.
 */
export function buildTableNote(aiNote, { asked, count, roster, filled } = {}) {
  const parts = [];
  const note = String(aiNote || '').trim();
  parts.push(note
    || '이 표는 공식 순위가 아니라 일반적으로 알려진 정보를 정리한 참고 자료이며, '
      + '최신 정보는 직접 확인하시기 바랍니다.');

  const basis = String(roster?.rankBasis || '').trim();
  if (basis && !note.includes(basis)) {
    // 기준 문구가 무엇으로 끝날지 알 수 없어 조사(을/를)를 붙이지 않는다.
    // "취업률을(를) 기준으로" 처럼 읽히면 글이 기계 같아진다.
    parts.push(`순위는 "${basis}" 기준으로 줄을 세운 것입니다.`);
  }

  /*
   * 실제로 표에 담긴 줄 수(filled)를 기준으로 안내한다.
   *
   * 노린 개수(count)를 적어두면 31줄짜리 표 밑에 "50개를 담았습니다" 가 붙는다.
   * 독자가 세어 보면 바로 틀린 말이다. 몇 줄이든 **담긴 만큼만** 말한다.
   */
  const shown = Number(filled) || Number(count) || 0;

  if (asked && shown && shown < asked) {
    parts.push(
      `${asked}개를 목표로 했지만 확인할 수 있는 대상이 ${shown}개여서 `
      + `${shown}개까지 순위를 매겼습니다.`,
    );
  } else if (roster?.total && shown && roster.total > shown) {
    parts.push(`전체 약 ${roster.total}개 가운데 상위 ${shown}개를 담았습니다.`);
  }

  return parts.join(' ');
}

/** 전수 조사 결과를 글쓰기 프롬프트에 알려주는 블록. */
function rosterBlock({ asked, count, roster }) {
  if (!roster) return '';
  const lines = ['[전수 조사 결과 — 표의 개수는 이미 정해졌습니다]'];

  if (asked && count < asked) {
    lines.push(
      `이 주제는 ${asked}개를 요구하지만, 조사해 보니 해당 범주에 실제로 존재하는 대상은 `
      + `${count}개입니다. 그래서 이 글의 표는 **${count}개 행**으로 갑니다.`,
      `제목과 도입부에 ${asked}개라고 쓰지 마세요. ${count}개를 전부 담았다는 사실을 `
      + '오히려 강점으로 써 주세요. (예: "전국 26곳을 하나도 빼지 않고 정리했습니다")',
      '없는 대상을 지어내 개수를 채우면 안 됩니다.',
    );
  } else {
    lines.push(`이 글의 표는 **${count}개 행**으로 갑니다. 이 숫자를 그대로 쓰세요.`);
    if (roster.total && roster.total > count) {
      lines.push(`참고로 이 범주에는 전체 약 ${roster.total}개가 있고, 그중 상위 ${count}개를 담습니다.`);
    }
  }

  if (roster.rankBasis) {
    lines.push(
      `순위 기준은 "${roster.rankBasis}" 입니다. 선정 기준 단락에 이 기준을 그대로 밝히고, `
      + '공식 순위가 아니라는 점도 함께 적어 주세요.',
    );
  }
  if (roster.names?.length) {
    lines.push(
      `조사해둔 실제 목록 ${roster.names.length}개 중 앞부분: `
      + `${roster.names.slice(0, 40).join(', ')}`,
    );
  }
  return `${lines.join('\n')}\n\n============================================================\n`;
}

export function buildMainPrompt(topic, settings, {
  guidelineBlock, exampleBlock, researchBlock, shape, count, asked, roster, fixedTitle,
}) {
  const withTableRows = shape !== 'table';   // 큰 표는 뒤에서 따로 채운다.
  const tableHint = withTableRows
    ? `- table.rows 를 ${count ? `${count}개` : '항목 수만큼'} 빠짐없이 채우세요. "이하 생략" 금지.`
    : `- 이 글에는 ${count}개 항목이 들어간 큰 표가 하나 들어갑니다. `
      + '표의 행은 뒤에서 따로 채우므로 지금은 headers 와 heading, note 만 잡고 rows 는 넣지 마세요.';

  return `${buildFixedTitleBlock(fixedTitle)}${guidelineBlock}${rosterBlock({ asked, count, roster })}${basicsBlock(settings, topic)}

위 주제로 네이버 블로그에 올릴 정보성 포스팅 한 편을 써주세요.
${researchBlock ? `\n${researchBlock}` : ''}
${buildRuleBlock(settings, shape)}

${structureGuide(shape, settings, count)}
${tableHint}

${honestyBlock(Boolean(researchBlock), settings.post.neverRefuse)}

${FORMAT_BLOCK}

${metaBlock(Boolean(fixedTitle))}

${THUMBNAIL_BLOCK}
${exampleBlock ? `\n${exampleBlock}\n` : ''}
[출력] JSON 객체 하나만. 설명도 코드 펜스도 붙이지 마세요.

${jsonShape({
    withItems: shape === 'items',
    withFaq: settings.post.addFaq,
    withCriteria: settings.post.addCriteria,
    withTableRows,
    withFixedTitle: Boolean(fixedTitle),
  })}

필요 없는 키는 빼도 되지만 title, intro, sections, outro, table 은 반드시 채우세요.${buildGuidelineReminder(settings.post.extraGuideline)}`;
}

/* ------------------------------------------------------------------ */
/* 응답 정규화                                                          */
/* ------------------------------------------------------------------ */

const STYLES = new Set(['bold', 'gradient', 'minimal', 'editorial']);

function toParagraphList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function normalizeTable(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const headers = (Array.isArray(raw.headers) ? raw.headers : [])
    .map((header) => String(header ?? '').trim())
    .filter(Boolean);
  if (headers.length < 2) return null;

  const rows = (Array.isArray(raw.rows) ? raw.rows : [])
    .map((row) => {
      const cells = Array.isArray(row)
        ? row.map((cell) => String(cell ?? '').trim())
        : (row && typeof row === 'object' ? Object.values(row).map((cell) => String(cell ?? '').trim()) : null);
      if (!cells) return null;
      const fixed = cells.slice(0, headers.length);
      while (fixed.length < headers.length) fixed.push('');
      return fixed;
    })
    .filter((row) => row && row.some((cell) => cell));

  return {
    heading: String(raw.heading || '').trim(),
    headers,
    rows,
    note: String(raw.note || '').trim(),
  };
}

function normalizeSubsections(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((sub) => ({
      heading: String(sub?.heading || '').trim(),
      paragraphs: toParagraphList(sub?.paragraphs ?? sub?.body ?? sub?.content),
      list: toParagraphList(sub?.list ?? sub?.items),
    }))
    .filter((sub) => sub.heading && (sub.paragraphs.length || sub.list.length));
}

function normalizeCriteria(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const criteria = {
    heading: String(raw.heading || '추천 항목을 고른 기준').trim(),
    paragraphs: toParagraphList(raw.paragraphs ?? raw.body),
    items: toParagraphList(raw.items ?? raw.list),
  };
  if (!criteria.paragraphs.length && !criteria.items.length) return null;
  return criteria;
}

function normalizeFaq(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((item) => ({
      question: String(item?.question ?? item?.q ?? '').trim(),
      answer: String(item?.answer ?? item?.a ?? '').trim(),
    }))
    .filter((item) => item.question && item.answer)
    .slice(0, 8);
}

export function normalize(raw, topic, settings, shape = 'general', fixedTitle = '') {
  /*
   * 제목을 사용자가 정해 줬으면 모델이 뭘 보냈든 그것으로 덮어쓴다.
   *
   * 프롬프트로 "바꾸지 마세요" 를 못박아도 모델은 맞춤법을 고치거나 길이를
   * 줄이거나 "2026년" 을 붙이는 식으로 손을 댄다. 제목을 고정하겠다고 한 이상
   * 글자 하나도 달라지면 안 되므로 코드에서 확실히 끝낸다.
   *
   * 길이도 자르지 않는다. 사용자가 100자짜리 제목을 넣었다면 그게 맞다고 본 것이다.
   */
  const locked = String(fixedTitle || '').trim();
  const title = locked || String(raw.title || topic).trim().slice(0, 100);

  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .map((section) => ({
      heading: String(section?.heading || '').trim(),
      isItem: Boolean(section?.isItem),
      paragraphs: toParagraphList(section?.paragraphs ?? section?.body ?? section?.content),
      list: toParagraphList(section?.list ?? section?.items),
      quote: String(section?.quote || '').trim(),
      subsections: normalizeSubsections(section?.subsections ?? section?.sub),
    }))
    .filter((section) => section.heading || section.paragraphs.length);

  const thumb = raw.thumbnail && typeof raw.thumbnail === 'object' ? raw.thumbnail : {};
  const requested = settings.thumbnail.style;
  const style = requested !== 'auto' && STYLES.has(requested)
    ? requested
    : (STYLES.has(thumb.style) ? thumb.style : 'minimal');
  const accent = /^#[0-9a-f]{6}$/i.test(String(thumb.accent || '')) ? thumb.accent : '#16324F';

  const post = {
    topic,
    shape,
    title,
    summary: String(raw.summary || '').trim(),
    guideline: String(settings.post.extraGuideline || '').trim(),
    guidelineCheck: String(raw.guidelineCheck || '').trim(),
    // 네이버 태그에는 공백과 특수문자를 넣을 수 없다. 붙여 쓰고 중복을 걸러낸다.
    tags: [...new Set(
      (Array.isArray(raw.tags) ? raw.tags : [])
        .map((tag) => normalizeTag(tag))
        .filter(Boolean),
    )].slice(0, 8),
    thumbnail: {
      headline: String(thumb.headline || title).trim().slice(0, 40),
      subline: String(thumb.subline || raw.summary || '').trim().slice(0, 60),
      badge: String(thumb.badge || '').trim().slice(0, 12),
      emoji: String(thumb.emoji || '').trim().slice(0, 4),
      // 썸네일에 통째로 그려 넣을 문구들. 이미지 API 를 껐으면 안 쓰인다.
      // 한 줄이 길면 이미지 모델이 글자를 뭉개므로 여기서 잘라 둔다.
      posterLines: (Array.isArray(thumb.posterLines) ? thumb.posterLines : [])
        .map((line) => String(line).trim().slice(0, 20))
        .filter(Boolean)
        .slice(0, 3),
      ribbon: String(thumb.ribbon || '').trim().slice(0, 24),
      keywords: (Array.isArray(thumb.keywords) ? thumb.keywords : [])
        .map((word) => String(word).trim().slice(0, 8))
        .filter(Boolean)
        .slice(0, 5),
      // 배경 그림 생성 프롬프트에 들어갈 장면 설명.
      scene: String(thumb.scene || '').trim().slice(0, 300),
      style,
      accent,
    },
    intro: toParagraphList(raw.intro),
    criteria: settings.post.addCriteria ? normalizeCriteria(raw.criteria) : null,
    table: normalizeTable(raw.table),
    sections,
    faq: settings.post.addFaq ? normalizeFaq(raw.faq) : [],
    outro: toParagraphList(raw.outro),
    // 조사 단계에서 채운다. 글 끝의 출처 목록이 된다.
    sources: [],
    research: null,
    model: '',
    costUsd: 0,
    compliance: null,
    repairs: 0,
  };

  if (!post.intro.length && post.sections.length) {
    // 도입부가 비면 썸네일과 more 태그가 들어갈 자리가 없어진다. 첫 문단을 끌어올린다.
    post.intro = post.sections[0].paragraphs.splice(0, 1);
  }
  if (!post.sections.length) {
    throw new Error('AI 응답에 본문 섹션이 없습니다.');
  }
  return post;
}

/** 보정 요청에 되돌려 보낼 JSON. 내부 관리용 필드는 뺀다. */
/**
 * 보정 요청에 실어 보낼 모양.
 *
 * 구간을 나눠 받은 큰 표는 **행을 빼고** 보낸다. 50행짜리 표를 그대로 실어
 * 보내면 모델이 글을 고쳐 쓰면서 표를 "1~10위 ... 이하 생략" 으로 줄여 버린다.
 * 어렵게 채운 표가 보정 한 번에 날아가는 셈이다. 행은 여기서 만들지 않으므로
 * 보정 결과를 받은 뒤 원래 표를 그대로 다시 끼운다.
 */
function toAiJson(post, { keepTableRows = true } = {}) {
  const out = {
    title: post.title,
    summary: post.summary,
    tags: post.tags,
    guidelineCheck: post.guidelineCheck,
    thumbnail: post.thumbnail,
    intro: post.intro,
    sections: post.sections.map((section) => ({
      heading: section.heading,
      ...(section.isItem ? { isItem: true } : {}),
      paragraphs: section.paragraphs,
      ...(section.list.length ? { list: section.list } : {}),
      ...(section.quote ? { quote: section.quote } : {}),
      ...(section.subsections.length ? { subsections: section.subsections } : {}),
    })),
    outro: post.outro,
  };
  if (post.criteria) out.criteria = post.criteria;
  if (post.table) {
    out.table = keepTableRows
      ? post.table
      : {
        ...post.table,
        rows: [],
        rowsNote: `행 ${post.table.rows?.length || 0}개는 이미 확정되어 있습니다. `
          + 'rows 는 빈 배열로 두세요. 표의 행은 고치지 않습니다.',
      };
  }
  if (post.faq.length) out.faq = post.faq;
  return out;
}

export { countChars };

/* ------------------------------------------------------------------ */
/* 생성                                                                */
/* ------------------------------------------------------------------ */

/**
 * 준수 검사에서 걸린 항목만 짚어 다시 쓰게 한다.
 * 규칙이 통과할 때까지 최대 maxRepairs 번 돈다.
 */
async function repairUntilCompliant(post, {
  topic, settings, systemPrompt, signal, onProgress, fixedTitle = '',
}) {
  let current = post;
  current.compliance = checkCompliance(current, settings);

  if (current.compliance.ok || !settings.quality.enforce) return current;

  // 구간을 나눠 받은 표인지. 그렇다면 보정 과정에서 표를 건드리지 않게 지킨다.
  const chunkedTable = Boolean(post.tableExpected) && Boolean(post.table?.rows?.length);
  const keptTable = chunkedTable ? structuredClone(post.table) : null;

  const limit = Math.max(0, Number(settings.quality.maxRepairs) || 0);
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    logger.warn(
      `[${topic}] 품질 검사 미통과 (${attempt}/${limit} 보정 시도) — `
      + current.compliance.issues.map((issue) => `${issue.label}: ${issue.detail}`).join(' / '),
    );
    onProgress?.(current.compliance);

    const prompt = [
      buildRepairBlock(current.compliance),
      '',
      '============================================================',
      `주제: "${topic}"`,
      '',
      '[현재 글 — 이것을 고쳐서 전체를 다시 출력하세요]',
      JSON.stringify(toAiJson(current, { keepTableRows: !chunkedTable }), null, 2),
      '',
      buildRuleBlock(settings, current.shape),
      '',
      FORMAT_BLOCK,
      '',
      '[출력] 고친 글 전체를 같은 구조의 JSON 객체 하나로만 출력하세요.',
    ].join('\n');

    let reply;
    try {
      reply = await runChatGptJson(prompt, { systemPrompt, signal });
    } catch (error) {
      logger.warn(`[${topic}] 보정 요청 실패, 원래 글을 그대로 씁니다: ${error.message}`);
      break;
    }

    let repaired;
    try {
      repaired = normalize(reply.data, topic, settings, current.shape, fixedTitle);
    } catch (error) {
      logger.warn(`[${topic}] 보정 결과를 읽지 못했습니다: ${error.message}`);
      break;
    }

    repaired.model = reply.model || current.model;
    repaired.costUsd = (current.costUsd || 0) + (reply.costUsd || 0);
    repaired.repairs = attempt;
    // 조사 결과는 글을 고쳐 쓴다고 달라지지 않는다. 그대로 물려준다.
    repaired.sources = current.sources;
    repaired.research = current.research;
    repaired.tableExpected = current.tableExpected;
    repaired.tableAsked = current.tableAsked;
    repaired.tableFilled = current.tableFilled;
    repaired.tableMissing = current.tableMissing;
    repaired.rankBasis = current.rankBasis;
    repaired.rosterTotal = current.rosterTotal;

    // 어렵게 채운 표를 그대로 다시 끼운다. 보정은 글만 고치는 일이다.
    if (keptTable) repaired.table = structuredClone(keptTable);
    repaired.compliance = checkCompliance(repaired, settings);

    // 고친 결과가 더 나빠졌다면 되돌린다. (규칙 통과 개수로 판단)
    if (repaired.compliance.passed < current.compliance.passed) {
      logger.warn(`[${topic}] 보정 결과가 오히려 나빠져 이전 글을 유지합니다.`);
      break;
    }
    current = repaired;
    if (current.compliance.ok) {
      logger.info(`[${topic}] 보정 후 준수 검사를 통과했습니다. (${summarize(current.compliance)})`);
      break;
    }
  }

  return current;
}

export async function generatePost(topic, options = {}) {
  const settings = getSettings();
  const guideline = String(settings.post.extraGuideline || '').trim();
  const guidelineBlock = buildGuidelineBlock(guideline);
  const exampleBlock = buildExampleBlock();
  const systemPrompt = buildSystemPrompt(guideline);

  /*
   * 사용자가 제목을 직접 정해 준 경우.
   *
   * 글의 모양(항목별 / 큰 표 / 정보 정리)은 **제목을 보고** 정한다. 제목에
   * "TOP 50" 이 들어 있으면 50줄짜리 표로 가야 하기 때문이다. 제목을 정해 줬을
   * 때는 제목이 곧 주제이므로 topic 과 같은 값이지만, 따로 받은 값이 있으면
   * 그쪽을 우선해서 모양을 잡는다.
   */
  const fixedTitle = String(options.fixedTitle || '').trim();
  const shapeSource = fixedTitle || topic;
  const { shape, count: asked, needsChunking } = detectShape(
    shapeSource,
    settings.post.rankTargetCount,
  );

  logger.step(
    `[${topic}] 글 모양: ${
      { items: '항목별 상세형', table: '대형 비교표형', general: '정보 정리형' }[shape]
    }${asked ? ` (${asked}개 항목)` : ''}`,
  );
  if (fixedTitle) logger.info(`제목 고정: "${fixedTitle}"`);
  if (guideline) logger.info(`추가 지침 적용: ${guideline.replace(/\s+/g, ' ').slice(0, 120)}`);
  if (exampleBlock) logger.info('참고 예시를 프롬프트에 함께 넣었습니다.');
  if (asked && asked > ITEM_LIMIT) {
    logger.info(`항목이 ${asked}개라 표를 나눠 받고 대표 항목만 상세하게 씁니다.`);
  }

  /* 1단계 — 웹 검색으로 자료를 모은다. (설정에서 끄면 건너뛴다) */
  options.onResearch?.();
  const research = await runResearch(topic, { shape, count: asked, signal: options.signal });
  const researchBlock = research ? buildResearchBlock(research) : '';

  if (settings.research.enabled && settings.research.requireSources
      && !(research?.sources?.length)) {
    throw new Error(
      '웹 검색으로 출처를 구하지 못해 글을 쓰지 않았습니다. '
      + '(설정에서 "출처를 못 구하면 글을 쓰지 않기" 를 끄면 검색 없이도 씁니다)',
    );
  }

  /*
   * 1.5단계 — 큰 순위표를 쓸 주제면, 대상이 실제로 몇 개 있는지부터 센다.
   *
   * "2026 전문대 순위 TOP 50" 이라면 전국의 전문대를 먼저 전수 조사한다.
   * 50개보다 많으면 50개까지만 줄을 세우고, 26개밖에 없으면 26개 전부로
   * 줄을 세운다. 없는 이름을 지어내 50줄을 채우는 것보다 26줄짜리 정확한
   * 표가 낫고, 반대로 130곳이 있는데 12곳만 쓰는 표는 쓸모가 없다.
   *
   * **이 숫자를 글쓰기보다 먼저 정해야 한다.** 제목과 도입부에 개수가 들어가기
   * 때문에, 표를 채우고 나서 숫자가 달라지면 제목이 "TOP 50" 인데 표는 26줄인
   * 글이 나온다.
   */
  let roster = null;
  let count = asked;
  if (needsChunking && asked) {
    options.onRoster?.();
    logger.step(`[${topic}] 순위를 매길 대상을 전수 조사합니다. (목표 ${asked}개)`);
    roster = await collectRoster(topic, asked, { signal: options.signal });
    count = decideRowCount(asked, roster);

    if (count < asked) {
      logger.info(
        `[${topic}] 이 범주에는 ${count}개까지만 있는 것으로 확인됐습니다. `
        + `${asked}개를 억지로 채우지 않고 ${count}개 전부로 줄을 세웁니다.`,
      );
    } else if (roster.names.length) {
      logger.info(
        `[${topic}] 전수 조사로 ${roster.names.length}개를 확보했습니다. `
        + `${count}개까지 줄을 세웁니다.`
        + (roster.rankBasis ? ` (기준: ${roster.rankBasis})` : ''),
      );
    }
  }

  /* 2단계 — 도구를 끄고, 모아온 자료만 보고 글을 쓴다. */
  const reply = await runChatGptJson(
    buildMainPrompt(topic, settings, {
      guidelineBlock, exampleBlock, researchBlock, shape, count, asked, roster, fixedTitle,
    }),
    {
      systemPrompt,
      signal: options.signal,
      // 거절하면 "추정으로라도 쓰라" 고 한 번 되묻는다. 그래야 주제가 안 날아간다.
      insist: settings.post.neverRefuse ? INSIST_BLOCK : '',
    },
  );

  let post = normalize(reply.data, topic, settings, shape, fixedTitle);
  post.model = reply.model || '';
  post.costUsd = (reply.costUsd || 0) + (research?.costUsd || 0);
  post.research = research;
  post.sources = settings.research.showSources ? (research?.sources || []) : [];

  // 큰 표는 본문과 따로, 구간을 나눠 받는다.
  if (needsChunking) {
    const headers = post.table?.headers?.length >= 2
      ? post.table.headers
      : ['순위', '항목', '핵심 특징'];

    const { rows, model, missing, renumbered } = await generateTableRows({
      topic,
      headers,
      count,
      signal: options.signal,
      onProgress: options.onProgress,
      roster,
      rankBasis: roster?.rankBasis || '',
    });

    post.table = {
      heading: post.table?.heading || `${topic} 전체 정리`,
      headers,
      rows,
      note: buildTableNote(post.table?.note, { asked, count, roster, filled: rows.length }),
    };
    post.model = post.model || model || '';
    post.tableExpected = count;
    post.tableAsked = asked;
    post.tableFilled = rows.length;
    post.tableMissing = missing;
    post.rankBasis = roster?.rankBasis || '';
    post.rosterTotal = roster?.total || null;

    if (missing.length) {
      logger.warn(
        `표에서 ${missing.length}개 행을 끝내 채우지 못했습니다. `
        + `${rows.length}개로 1위부터 다시 번호를 매겨 표를 완성했습니다. `
        + '(빈 줄을 남기거나 글을 버리지 않습니다)',
      );
    } else {
      logger.info(`표 ${rows.length}개 행을 빠짐없이 채웠습니다.`);
    }
  }

  post = await repairUntilCompliant(post, {
    topic,
    settings,
    systemPrompt,
    signal: options.signal,
    onProgress: options.onCompliance,
    fixedTitle,
  });

  // 마지막 확인. 어느 경로로 왔든 정해준 제목과 다르면 안 된다.
  if (fixedTitle && post.title !== fixedTitle) {
    logger.warn(`[${topic}] 제목이 바뀌어 정해주신 제목으로 되돌렸습니다: "${post.title}"`);
    post.title = fixedTitle;
  }

  return post;
}
