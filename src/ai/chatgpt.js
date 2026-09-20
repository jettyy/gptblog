import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';
import { LOG_DIR, ensureDirs } from '../lib/paths.js';
import { askChatGptWeb } from './webchat.js';

/**
 * 글쓰기를 맡는 AI.
 *
 * **API 키 종량제를 쓰지 않는다.** 이미 내고 있는 ChatGPT 구독 계정을 그대로 쓴다.
 * 구독 계정으로 글을 받아오는 길은 두 가지가 있고, 설정에서 고른다.
 *
 *   codex — OpenAI Codex CLI 를 `codex exec` 로 부른다. (기본, 권장)
 *           `codex login` 으로 ChatGPT 계정에 한 번 로그인해 두면 그 구독으로 돈다.
 *           긴 JSON 을 안정적으로 돌려주고, 웹 검색도 켤 수 있다.
 *
 *   web   — chatgpt.com 을 실제 브라우저로 띄워 대화창에 물어본다.
 *           CLI 를 깔 수 없을 때의 길이다. 화면 구조가 바뀌면 깨지므로 예비용이다.
 *
 * 그림은 CLI 로 만들 수 없어서 어느 쪽을 골라도 chatgpt.com 쪽을 쓴다.
 * (src/content/imagegen.js 참고)
 */

const IS_WINDOWS = process.platform === 'win32';

/**
 * 윈도우 콘솔은 한국어를 CP949(EUC-KR)로 내보낸다.
 * 그대로 UTF-8 로 읽으면 "모델을 찾을 수 없습니다" 가 "���� ã�� �� �����ϴ�" 로 깨진다.
 */
function decodeOutput(chunks) {
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) return '';

  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) return utf8;

  for (const encoding of ['euc-kr', 'cp949', 'windows-1252']) {
    try {
      const alternative = new TextDecoder(encoding).decode(buffer);
      if (!alternative.includes('�')) return alternative;
    } catch {
      // 이 인코딩은 이 런타임에서 지원하지 않는다. 다음 후보로.
    }
  }
  return utf8;
}

/**
 * shell 을 거칠 때는 Node 가 인자를 따옴표로 감싸주지 않는다.
 * 공백이 든 인자를 그냥 넘기면 여러 조각으로 쪼개져 CLI 가 종료 코드 1로 죽는다.
 */
function quoteForShell(value) {
  const text = String(value);
  if (!/[\s"^&|<>()%!]/.test(text)) return text;
  return IS_WINDOWS ? `"${text.replace(/"/g, '""')}"` : `'${text.replace(/'/g, `'\\''`)}'`;
}

/** 사용량/요청 한도에 걸린 오류인지. 이 경우 계속 돌려봐야 전부 실패한다. */
function looksRateLimited(message) {
  return /(rate[ _-]?limit|usage limit|too many requests|429|quota|insufficient_quota|한도|사용량|제한을 초과)/i
    .test(String(message));
}

/**
 * ChatGPT 로그인이 풀린 오류인지.
 *
 * 한도와 마찬가지로 **계속 돌려봐야 전부 같은 이유로 실패한다.**
 * 다만 한도는 기다리면 풀리고 이건 사람이 다시 로그인해야 풀린다.
 * 둘을 섞으면 "잠시 뒤 다시" 라는 엉뚱한 안내가 나가므로 따로 본다.
 *
 * 실제로 겪은 메시지:
 *   Not logged in. Run `codex login` to authenticate.
 *   ERROR: 401 Unauthorized
 */
export function looksAuthExpired(message) {
  return /(not logged ?in|please log ?in|login required|run `?codex login|codex login`?|reauthenticate|re-?authenticate|oauth|token (?:has )?expired|session expired|not authenticated|unauthenticated|invalid api key|authentication[_ -]?error|401|unauthorized|로그인이 필요)/i
    .test(String(message));
}

/** 로그인이 풀렸을 때 사람이 무엇을 해야 하는지. 한 군데에만 적어 둔다. */
export const AUTH_HINT = 'ChatGPT 로그인이 풀렸습니다. 검은 창(터미널)에서 `codex login` 을 실행해 '
  + 'ChatGPT 구독 계정으로 다시 로그인한 뒤, 대시보드에서 [이어서 실행]을 눌러주세요. '
  + '(웹 방식을 쓰고 있다면 대시보드 1번 칸의 [ChatGPT 로그인 창 열기] 를 누르세요)';

/** 실패했을 때 원문을 파일로 남긴다. 깨진 메시지만 보고는 원인을 못 찾는다. */
function dumpFailure({ args, stdout, stderr, code }) {
  try {
    ensureDirs();
    const file = path.join(LOG_DIR, `chatgpt-fail-${Date.now()}.log`);
    fs.writeFileSync(file, [
      `exit code: ${code}`,
      `platform: ${process.platform}`,
      `args: ${JSON.stringify(args)}`,
      '',
      '--- stdout ---',
      stdout,
      '',
      '--- stderr ---',
      stderr,
    ].join('\n'), 'utf8');
    return file;
  } catch {
    return '';
  }
}

/**
 * 종료 코드가 0이 아니어도 codex 는 stdout 에 이유를 적어놓는 경우가 있다.
 * stderr 만 보면 "(stderr 없음)" 으로 끝나 원인을 놓친다.
 */
function errorMessageFrom(stdout, stderr) {
  const trimmedErr = stderr.trim();
  if (trimmedErr) return trimmedErr.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400);

  const trimmedOut = stdout.trim();
  if (trimmedOut) {
    // JSONL 안에 error 항목이 들어 있으면 그게 가장 정확한 이유다.
    for (const line of trimmedOut.split('\n').reverse()) {
      const parsed = parseLine(line);
      const detail = parsed?.error?.message || parsed?.msg?.message || parsed?.message;
      if (parsed && /error/i.test(JSON.stringify(parsed.type || parsed.msg?.type || '')) && detail) {
        return String(detail).slice(0, 400);
      }
    }
    const tail = trimmedOut.split('\n').filter(Boolean).slice(-3).join(' ');
    if (tail) return tail.slice(0, 400);
  }
  return '';
}

function parseLine(line) {
  const text = String(line).trim();
  if (!text.startsWith('{')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 이 JSON 줄이 codex 가 흘리는 **진행 상황 이벤트**인지.
 *
 * 그냥 "JSON 으로 파싱되면 이벤트" 로 보면 안 된다. 우리가 시키는 일이
 * 바로 "JSON 하나만 출력해라" 여서, --json 이 막힌 판에서는 **답 자체가
 * JSON 한 줄**로 온다. 그걸 이벤트로 착각해 버리면 답을 통째로 버리고
 * "응답이 비어 있습니다" 로 끝난다.
 */
function looksLikeEvent(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  return typeof parsed.type === 'string'
    || (parsed.msg && typeof parsed.msg === 'object')
    || (parsed.item && typeof parsed.item === 'object');
}

/* ------------------------------------------------------------------ */
/* codex exec 출력 읽기                                                */
/* ------------------------------------------------------------------ */

/**
 * codex CLI 는 판이 올라가면서 --json 이벤트 이름을 몇 번 바꿨다.
 * 한 가지 모양만 읽으면 CLI 를 올린 순간 "응답이 비었습니다" 로 멈춘다.
 * 그래서 아는 모양을 전부 훑고, 마지막으로 나온 답을 쓴다.
 */
function agentTextFrom(event) {
  if (!event || typeof event !== 'object') return '';

  // 구판: {"msg":{"type":"agent_message","message":"..."}}
  const legacy = event.msg;
  if (legacy?.type === 'agent_message') return String(legacy.message ?? legacy.text ?? '');

  // 신판: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
  const item = event.item;
  if (item && /agent_message|assistant_message/i.test(String(item.type || ''))) {
    return String(item.text ?? item.message ?? '');
  }

  // 납작한 모양: {"type":"agent_message","message":"..."}
  if (/^(agent_message|assistant_message)$/i.test(String(event.type || ''))) {
    return String(event.message ?? event.text ?? '');
  }
  return '';
}

/** 웹 검색을 실제로 몇 번 돌렸는지. 0 이면 "검색했다고 말만 한 것" 이다. */
function looksWebSearch(event) {
  const names = [
    event?.msg?.type, event?.type, event?.item?.type,
    event?.item?.name, event?.msg?.name, event?.name,
    event?.item?.tool_name, event?.msg?.tool_name,
  ];
  return names.some((name) => /web_?search|web_?fetch|browse/i.test(String(name || '')));
}

function usageFrom(event) {
  const usage = event?.msg?.info?.total_token_usage
    || event?.msg?.info?.last_token_usage
    || event?.usage
    || event?.msg?.usage
    || event?.item?.usage;
  if (!usage || typeof usage !== 'object') return null;
  return usage;
}

/** JSONL 이 아닌 평범한 출력에서 codex 가 찍는 머리말을 걷어낸다. */
function stripPlainOutput(stdout) {
  const lines = String(stdout).split('\n');
  const body = [];
  for (const line of lines) {
    const text = line.trimEnd();
    // codex exec 는 실행 정보를 먼저 찍는다. 답이 아니다.
    if (/^-{3,}$/.test(text.trim())) continue;
    if (/^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text.trim())) continue;
    if (/^(workdir|model|provider|approval|sandbox|reasoning|session|codex|tokens used|user|OpenAI Codex)\b\s*:?/i.test(text.trim())) continue;
    body.push(text);
  }
  return body.join('\n').trim();
}

/**
 * JSONL(--json) 이든 평문이든 stdout 에서 답과 부수 정보를 뽑는다.
 * @returns {{text: string, searches: number, tokens: number}}
 */
export function parseCodexOutput(stdout) {
  const lines = String(stdout).split('\n');
  let text = '';
  let searches = 0;
  let tokens = 0;
  let sawEvent = false;

  for (const line of lines) {
    const event = parseLine(line);
    if (!looksLikeEvent(event)) continue;
    sawEvent = true;

    const answer = agentTextFrom(event);
    // 마지막 답을 쓴다. 중간에 상황 설명을 한 줄 흘리는 판도 있다.
    if (answer.trim()) text = answer;

    if (looksWebSearch(event)) searches += 1;

    const usage = usageFrom(event);
    if (usage) {
      tokens = Math.max(
        tokens,
        Number(usage.total_tokens ?? usage.total ?? 0)
          || (Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0)),
      );
    }
  }

  // 이벤트 줄이 하나도 없었다면 --json 이 막힌 판이다. 평문으로 읽는다.
  if (!text.trim() && !sawEvent) text = stripPlainOutput(stdout);
  return { text: text.trim(), searches, tokens };
}

/* ------------------------------------------------------------------ */
/* codex exec 호출                                                     */
/* ------------------------------------------------------------------ */

/**
 * 이 컴퓨터의 codex 가 받아주지 않은 옵션.
 *
 * CLI 판마다 옵션이 다르다. 한 번 거부당한 옵션을 계속 붙이면 모든 호출이
 * 종료 코드 2로 죽는다. 한 번 배우고 그다음부터는 빼고 부른다.
 */
const rejectedFlags = new Set();

/**
 * 이 오류 메시지가 "그 옵션은 못 쓴다" 는 뜻인지.
 *
 * 두 가지를 같이 본다.
 *   - 모르는 옵션          (CLI 판이 낮아 이름 자체가 없다)
 *   - 같이 못 쓰는 옵션    (clap 이 "cannot be used with" 로 거부한다)
 * 둘 다 "그 옵션을 빼고 다시 부르면 된다" 는 뜻이라 똑같이 다룬다.
 */
function unknownFlagIn(message, flags) {
  if (!/unexpected argument|unrecognized|unknown (?:option|flag|argument)|invalid (?:option|value)|no such (?:option|flag)|cannot be used with|conflicts with/i
    .test(message)) {
    return '';
  }
  return flags.find((flag) => message.includes(flag)) || '';
}

function buildArgs({ model, web, images, stdinPrompt, prompt }) {
  const optional = [];
  // exec 는 대화창 없이 한 번만 돌리는 모드다. 이게 -p(print) 에 해당한다.
  const args = ['exec'];

  // 작업 폴더가 git 저장소가 아니면 codex 가 실행을 거부한다. 글쓰기에는 상관없는 검사다.
  optional.push('--skip-git-repo-check');
  /*
   * 글쓰기에 파일 수정이나 명령 실행이 필요 없다. 읽기만 허용해 사고를 막는다.
   *
   * 여기에 --full-auto 를 같이 넣으면 안 된다. 그 옵션은 샌드박스를 쓰기 가능으로
   * 바꾸는 것이어서 --sandbox 와 **같이 쓸 수 없다**. 둘을 같이 주면 clap 이
   * "cannot be used with" 로 거부하고 종료 코드 2로 죽는다.
   * exec 모드는 원래 승인을 묻지 않으므로 --full-auto 가 필요하지도 않다.
   */
  optional.push('--sandbox', 'read-only');
  // 기계가 읽을 출력. 이게 막히면 평문을 읽는 쪽으로 물러선다.
  optional.push('--json');
  optional.push('--color', 'never');

  if (web) optional.push('--search');
  if (model) optional.push('--model', model);
  for (const image of images || []) optional.push('--image', image);

  // 거부당한 옵션은 값까지 같이 빼야 한다. (--model 만 빼면 모델 이름이 프롬프트로 들어간다)
  for (let index = 0; index < optional.length; index += 1) {
    const token = optional[index];
    if (!token.startsWith('--')) { args.push(token); continue; }
    const takesValue = ['--sandbox', '--color', '--model', '--image'].includes(token);
    if (rejectedFlags.has(token)) {
      if (takesValue) index += 1;
      continue;
    }
    args.push(token);
    if (takesValue && optional[index + 1] !== undefined) {
      args.push(optional[index + 1]);
      index += 1;
    }
  }

  /*
   * 프롬프트는 stdin 으로 넣는다. '-' 가 "stdin 에서 읽어라" 라는 뜻이다.
   * 윈도우에서 긴 인자가 공백 때문에 쪼개지는 문제를 원천적으로 피할 수 있다.
   *
   * '-' 를 모르는 판은 그것을 프롬프트 글자로 받아들이고 엉뚱한 답을 준다.
   * 그 경우(답이 비어 있거나 말이 안 되는 경우) 부르는 쪽에서 프롬프트를
   * 인자로 직접 넘겨 한 번 더 시도한다.
   */
  args.push(stdinPrompt ? '-' : prompt);
  return args;
}

/** codex 를 한 번 실행한다. 재시도 판단은 부르는 쪽에서 한다. */
function spawnCodex(fullPrompt, {
  model, web, images, limit, signal, stdinPrompt = true,
}) {
  const settings = getSettings();
  const command = settings.chatgpt.command || 'codex';
  const args = buildArgs({ model, web, images, stdinPrompt, prompt: fullPrompt });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, IS_WINDOWS ? args.map(quoteForShell) : args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: IS_WINDOWS,
        windowsHide: true,
      });
    } catch (error) {
      reject(new Error(`codex CLI 를 실행하지 못했습니다: ${error.message}`));
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let settled = false;
    const started = Date.now();

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`ChatGPT 응답이 ${Math.round(limit / 1000)}초 안에 오지 않았습니다.`));
    }, limit);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error('사용자가 중지했습니다.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => outChunks.push(chunk));
    child.stderr.on('data', (chunk) => errChunks.push(chunk));

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error.code === 'ENOENT') {
        reject(new Error(
          `codex CLI 를 찾을 수 없습니다. 'npm install -g @openai/codex' 로 설치하고 `
          + `'codex login' 으로 ChatGPT 구독 계정에 로그인한 뒤 다시 시도하세요. `
          + `(설정의 chatgpt.command 로 경로를 직접 지정할 수도 있습니다. `
          + `CLI 를 깔 수 없으면 설정에서 글쓰기 방식을 "웹" 으로 바꾸세요)`,
        ));
      } else {
        reject(error);
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        args,
        stdout: decodeOutput(outChunks),
        stderr: decodeOutput(errChunks),
        durationMs: Date.now() - started,
      });
    });

    /*
     * 프롬프트를 넘기다 파이프가 끊기는 경우가 있다.
     *
     * codex 가 프롬프트를 다 읽기 전에 끝나 버리면(로그인이 풀려서 곧바로
     * 죽는 경우가 대표적이다) 여기서 write EPIPE 가 난다. 받아주지 않으면
     * 그게 그대로 uncaughtException 이 되어 **서버 전체가 죽는다.**
     *
     * 진짜 원인(종료 코드와 stderr)은 'close' 에서 이미 읽어 알려주므로,
     * 여기서는 삼키고 그쪽 메시지가 나가게 둔다.
     */
    child.stdin.on('error', () => {});
    try {
      // 프롬프트를 인자로 넘긴 경우에도 stdin 은 닫아줘야 한다.
      // 열어두면 codex 가 stdin 을 계속 기다리며 끝나지 않는다.
      child.stdin.end(stdinPrompt ? fullPrompt : '', 'utf8');
    } catch {
      // 위와 같은 이유. 종료 코드 쪽에서 제대로 된 메시지가 나간다.
    }
  });
}

const OPTIONAL_FLAGS = [
  '--skip-git-repo-check', '--sandbox', '--json', '--color', '--search', '--image',
];

/**
 * ChatGPT 구독 계정으로 글을 받아온다.
 *
 * 시스템 프롬프트는 별도 인자가 아니라 본문 맨 앞에 넣는다.
 * CLI 판마다 인자 이름이 달라서, 본문에 넣는 쪽이 어느 판에서나 똑같이 먹는다.
 *
 * @param {object}   options
 * @param {boolean}  options.web     웹 검색을 쓰게 할지
 * @param {string[]} options.images  함께 보여줄 이미지 파일 경로 (썸네일 글자 확인용)
 * @returns {Promise<{text, model, costUsd, durationMs, searches, fetches}>}
 */
export async function runChatGpt(prompt, {
  systemPrompt = '', timeoutMs, signal, model, web = false, images = [],
} = {}) {
  const settings = getSettings();
  const limit = timeoutMs || settings.chatgpt.timeoutMs || 420000;
  const wanted = model ?? settings.chatgpt.model;

  const fullPrompt = systemPrompt
    ? `${systemPrompt}\n\n============================================================\n\n${prompt}`
    : prompt;

  // 웹 방식은 브라우저 대화창에 물어본다. 이미지 첨부는 CLI 쪽만 지원한다.
  if (settings.chatgpt.engine === 'web' && !images.length) {
    const reply = await askChatGptWeb(fullPrompt, { signal, timeoutMs: limit });
    return {
      text: reply.text,
      model: reply.model || settings.chatgpt.webModel || '',
      costUsd: 0,                 // 구독이라 호출당 값이 붙지 않는다.
      durationMs: reply.durationMs || 0,
      searches: reply.searches || 0,
      fetches: 0,
    };
  }

  /*
   * 프롬프트를 stdin 으로 넣는다. 다만 '-' 를 모르는 판이 있을 수 있어,
   * 그 경우 한 번은 인자로 직접 넘겨 본다. (아래 빈 응답 처리 참고)
   */
  let stdinPrompt = true;
  let triedArgPrompt = false;

  // 옵션이 거부당하면 그 옵션만 빼고 한 번 더. 옵션이 여러 개일 수 있어 몇 번 돈다.
  for (let attempt = 0; attempt <= OPTIONAL_FLAGS.length + 1; attempt += 1) {
    const result = await spawnCodex(fullPrompt, {
      model: wanted, web, images, limit, signal, stdinPrompt,
    });
    const { code, args, stdout, stderr, durationMs } = result;

    if (code !== 0) {
      const detail = errorMessageFrom(stdout, stderr);
      const unknown = unknownFlagIn(`${stderr}\n${stdout}`, OPTIONAL_FLAGS);
      if (unknown && !rejectedFlags.has(unknown)) {
        rejectedFlags.add(unknown);
        logger.warn(`이 컴퓨터의 codex 는 ${unknown} 옵션을 모릅니다. 빼고 다시 부릅니다.`);
        continue;
      }

      const dump = dumpFailure({ args, stdout, stderr, code });
      let hint = '';
      if (looksAuthExpired(detail)) {
        hint = ` — ${AUTH_HINT}`;
      } else if (looksRateLimited(detail)) {
        hint = ' — 사용량 한도에 걸린 것 같습니다. 잠시 뒤에 다시 시도하세요.';
      } else if (wanted && /model|모델/i.test(detail)) {
        hint = ` — '${wanted}' 모델을 쓸 수 없는 플랜일 수 있습니다. 설정에서 다른 모델을 골라보세요.`;
      } else if (!detail) {
        hint = dump ? ` — 원문을 ${dump} 에 남겼습니다.` : '';
      }

      const error = new Error(`codex CLI 종료 코드 ${code}: ${detail || '(출력 없음)'}${hint}`);
      error.rateLimited = looksRateLimited(detail);
      error.authExpired = looksAuthExpired(detail);
      error.dumpFile = dump;
      throw error;
    }

    const parsed = parseCodexOutput(stdout);
    if (!parsed.text) {
      /*
       * 종료 코드는 0인데 답이 없다.
       *
       * 가장 흔한 원인은 이 판의 codex 가 '-'(stdin 에서 읽기)를 모르는 것이다.
       * 그러면 '-' 한 글자를 프롬프트로 받고 할 말이 없어 조용히 끝난다.
       * 프롬프트를 인자로 직접 넘겨 한 번만 다시 시도해 본다.
       */
      if (stdinPrompt && !triedArgPrompt) {
        triedArgPrompt = true;
        stdinPrompt = false;
        logger.warn(
          '이 컴퓨터의 codex 가 stdin 프롬프트를 못 받은 것 같습니다. '
          + '프롬프트를 인자로 직접 넘겨 다시 부릅니다.',
        );
        continue;
      }

      const detail = errorMessageFrom(stdout, stderr);
      const dump = dumpFailure({ args, stdout, stderr, code });
      const error = new Error(
        `ChatGPT 응답이 비어 있습니다.${detail ? ` ${detail}` : ''}`
        + `${dump ? ` (원문: ${dump})` : ''}`,
      );
      error.rateLimited = looksRateLimited(detail);
      error.authExpired = looksAuthExpired(detail);
      error.dumpFile = dump;
      throw error;
    }

    return {
      text: parsed.text,
      model: wanted || '',
      costUsd: 0,                 // 구독이라 호출당 값이 붙지 않는다.
      durationMs,
      searches: parsed.searches,
      fetches: 0,
      tokens: parsed.tokens,
    };
  }

  throw new Error('codex CLI 가 어떤 옵션 조합도 받아주지 않았습니다. `codex --help` 로 판을 확인해 주세요.');
}

/** 모델이 앞뒤로 말을 덧붙였어도 JSON 본체만 뽑아낸다. */
export function extractJson(text) {
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // 첫 '{' 부터 마지막 '}' 까지 잘라 한 번 더 시도.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch (error) {
        throw new Error(`AI 응답을 JSON 으로 읽지 못했습니다: ${error.message}`);
      }
    }
    throw new Error('AI 응답에서 JSON 을 찾지 못했습니다.');
  }
}

/**
 * JSON 응답을 요구하는 호출. 한 번 실패하면 형식을 다시 일러주고 재시도한다.
 * @returns {Promise<{data: any, model: string, costUsd: number}>}
 */
export async function runChatGptJson(prompt, options = {}) {
  let lastText = '';
  try {
    const reply = await runChatGpt(prompt, options);
    lastText = reply.text;
    return {
      data: extractJson(reply.text),
      model: reply.model,
      costUsd: reply.costUsd,
      searches: reply.searches,
      fetches: reply.fetches,
    };
  } catch (error) {
    // 파싱이 깨졌을 때 원문이 없으면 왜 깨졌는지 알 방법이 없다.
    if (lastText) {
      const dump = dumpFailure({ args: ['(json parse)'], stdout: lastText, stderr: error.message, code: 0 });
      if (dump) logger.warn(`AI 원문을 ${dump} 에 남겼습니다.`);
    }

    /*
     * JSON 대신 긴 산문이 왔다면 형식 문제가 아니라 "이 주제로는 못 쓰겠다" 는 거절이다.
     *
     * 형식을 다시 일러줘도 소용없다. 필요한 건 형식 안내가 아니라 **"자료가 없어도
     * 아는 범위와 추정으로 쓰라"** 는 지시다. 그래서 부르는 쪽이 insist 를 넘겼으면
     * 그 말을 붙여 한 번만 더 물어본다.
     *
     * 한 번만이다. 두 번째도 거절하면 진짜로 못 쓰는 주제이니 호출을 더 버리지 않는다.
     */
    if (lastText.trim().length > 120 && !lastText.includes('{')) {
      const reason = lastText.trim().replace(/\s+/g, ' ').slice(0, 300);

      if (options.insist) {
        logger.warn(`AI가 거절했습니다. 추정으로라도 쓰라고 다시 요청합니다. (${reason.slice(0, 120)})`);
        try {
          // 되물을 때는 insist 를 빼서 부른다. 안 그러면 끝없이 서로 되물을 수 있다.
          const { insist, ...rest } = options;
          const retry = await runChatGpt(`${prompt}\n\n${insist}`, rest);
          return {
            data: extractJson(retry.text),
            model: retry.model,
            costUsd: retry.costUsd,
            searches: retry.searches,
            fetches: retry.fetches,
            insisted: true,
          };
        } catch (retryError) {
          logger.warn(`다시 요청했지만 또 실패했습니다: ${String(retryError.message).split('\n')[0]}`);
          // 아래로 내려가 원래 거절 이유를 그대로 올린다. 그게 사람이 볼 진짜 원인이다.
        }
      }

      const refusal = new Error(`AI가 이 주제로 글쓰기를 거절했습니다: ${reason}`);
      refusal.refusal = true;
      refusal.reason = lastText.trim();
      throw refusal;
    }
    // CLI 나 브라우저 자체가 실패한 경우는 형식을 다시 일러줘도 소용없다. 그대로 올린다.
    if (/종료 코드|찾을 수 없습니다|중지했습니다|오지 않았습니다|비어 있습니다|로그인/.test(error.message)) {
      throw error;
    }
    logger.warn(`AI 응답 파싱 실패, 형식을 다시 지정해 재시도합니다. (${error.message})`);
    const retryPrompt =
      `${prompt}\n\n`
      + `[중요] 설명이나 인사말 없이 JSON 객체 하나만 출력하세요. `
      + `코드 펜스(\`\`\`)도 쓰지 말고 '{' 로 시작해서 '}' 로 끝나야 합니다.`;
    const reply = await runChatGpt(retryPrompt, options);
    return {
      data: extractJson(reply.text),
      model: reply.model,
      costUsd: reply.costUsd,
      searches: reply.searches,
      fetches: reply.fetches,
    };
  }
}

/** CLI 가 설치·로그인되어 있는지 확인. */
export async function checkChatGpt() {
  const settings = getSettings();

  // 웹 방식으로 쓰겠다고 해 두었으면 CLI 가 없어도 정상이다.
  if (settings.chatgpt.engine === 'web') {
    return { ok: true, version: 'chatgpt.com (웹)', message: '', engine: 'web' };
  }

  const command = settings.chatgpt.command || 'codex';
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
      windowsHide: true,
    });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', () => resolve({
      ok: false,
      version: '',
      message: 'codex CLI 를 찾을 수 없습니다. npm install -g @openai/codex 로 설치한 뒤 '
        + 'codex login 으로 ChatGPT 구독 계정에 로그인하세요.',
      engine: 'codex',
    }));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, version: decodeOutput(chunks).trim(), message: '', engine: 'codex' });
      } else {
        resolve({ ok: false, version: '', message: `codex --version 종료 코드 ${code}`, engine: 'codex' });
      }
    });
  });
}
