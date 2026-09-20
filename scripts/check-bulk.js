/**
 * 큰 주제 여러 개 넣기 점검 (npm run check:bulk).
 *
 * `npm run check` 는 브라우저를 안 띄우기 때문에 대시보드(public/app.js)의
 * 동작은 하나도 검사하지 못한다. 그래서 **진짜 브라우저로 대시보드를 띄워**
 * 목록 붙여넣기만 돌려 본다. 네이버에도 ChatGPT 에도 접속하지 않는다.
 *
 * 이 파일이 생긴 이유:
 *   한 줄짜리 입력칸에 목록을 붙여넣으면 브라우저가 **줄바꿈을 공백으로 바꿔
 *   한 줄로 이어붙인다.** 그래서 주제 다섯 개가 "부동산 정책 국가 지원금 …"
 *   이라는 **주제 하나**로 대기열에 들어가 버렸다. 한 번 이어붙고 나면
 *   멀쩡한 긴 주제와 구분할 수 없어서 되돌릴 방법도 없다.
 *
 *   글자가 칸에 들어오는 길이 하나가 아니라는 것도 그때 드러났다.
 *   Ctrl+V(paste) 말고도 끌어다 놓기(drop)가 있는데, 예전에는 paste 만 막아서
 *   나머지 길로 들어온 목록이 그대로 뭉갰다.
 *
 * 그래서 여기서는 **길마다** 붙여넣어 보고, 서버로 나가는 주문을 가로채
 * "몇 건이, 무엇으로 들어갔는지" 를 직접 확인한다.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { chromiumOverride, ensureBrowsers } from '../src/lib/playwright.js';

const PORT = Number(process.env.BULK_CHECK_PORT || 3987);
const BASE = `http://127.0.0.1:${PORT}`;

/** 점검용 서버를 띄운다. 끝나면 반드시 내린다. */
async function startServer() {
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  // 포트가 열릴 때까지 기다린다. 고정 시간으로 자면 느린 컴퓨터에서 어긋난다.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/state`);
      if (response.ok) return child;
    } catch {
      // 아직 안 떴다.
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  child.kill('SIGKILL');
  throw new Error(`점검용 서버가 ${PORT}번 포트에 뜨지 않았습니다.`);
}

let failures = 0;
function check(ok, name, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '통과' : '실패'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

console.log('큰 주제 여러 개 넣기를 진짜 브라우저로 점검합니다.\n');

await ensureBrowsers();
const server = await startServer();
const executablePath = chromiumOverride();
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  // CI 나 도커에서는 샌드박스가 막혀 있는 경우가 많다.
  args: ['--no-sandbox'],
});

try {
  const page = await browser.newPage();

  /*
   * 주문 요청을 가로챈다. 진짜로 대기열에 넣지 않으면서
   * "무엇이 몇 건 나갔는지" 는 그대로 볼 수 있다.
   */
  const posted = [];
  await page.route('**/api/requests', (route) => {
    posted.push(route.request().postDataJSON().bigTopic);
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, request: {}, requests: [], started: false, startMessage: '' }),
    });
  });

  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error.message)));
  await page.goto(BASE, { waitUntil: 'networkidle' });

  const reset = async () => {
    posted.length = 0;
    await page.evaluate(() => {
      document.getElementById('bulk-topics').value = '';
      document.getElementById('bulk-box').classList.add('hidden');
      document.getElementById('s-big-topic').value = '';
    });
  };

  // 번호·글머리표·중복이 섞인, 실제로 사람이 붙여넣는 모양의 목록.
  const LIST = [
    '2026년 부동산 정책',
    '청년 국가 지원금',
    '1. 전기차 보조금',
    '- 건강보험 개편',
    '청년 국가 지원금',
  ].join('\n');

  /* ---------- Ctrl+V ---------- */
  await reset();
  await page.evaluate((text) => navigator.clipboard.writeText(text), LIST).catch(() => {});
  await page.locator('#s-big-topic').click();
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(400);

  check(
    await page.locator('#bulk-box').isVisible(),
    'Ctrl+V 로 목록을 붙여넣으면 여러 줄 칸이 열린다',
  );
  check(
    (await page.locator('#bulk-topics').inputValue()).split('\n').length === 5,
    '붙여넣은 줄이 중복까지 그대로 보인다 (왜 줄었는지 모르게 하지 않는다)',
    await page.locator('#bulk-topics').inputValue().then((v) => JSON.stringify(v)),
  );
  const counted = await page.locator('#bulk-count').textContent();
  check(
    counted.includes('4개 인식') && counted.includes('중복 1개 제외'),
    '넣기 전에 개수와 중복을 세어 보여준다',
    counted,
  );
  check(
    posted.length === 0,
    '붙여넣기만으로는 서버에 아무것도 나가지 않는다',
    `${posted.length}건 나감 — 확인할 틈도 없이 글 수백 편이 예약되면 안 됩니다`,
  );

  /* ---------- 실제 투입 ---------- */
  await page.locator('#btn-bulk-add').click();
  await page.waitForTimeout(1200);
  check(
    posted.length === 4
      && posted[2] === '전기차 보조금'      // "1. " 이 떨어졌는지
      && posted[3] === '건강보험 개편',      // "- " 가 떨어졌는지
    '[대기열에 모두 넣기] 로 줄마다 따로, 번호를 떼고, 중복은 한 번만 들어간다',
    JSON.stringify(posted),
  );

  /* ---------- 끌어다 놓기 ---------- */
  await reset();
  await page.evaluate((text) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', text);
    document.getElementById('s-big-topic').dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
  }, LIST);
  await page.waitForTimeout(400);
  check(
    await page.locator('#bulk-box').isVisible() && posted.length === 0,
    '끌어다 놓아도(drop) 가로챈다 — paste 만 막으면 이 길로 뭉개진다',
  );

  /* ---------- 한 줄짜리는 예전 그대로 ---------- */
  await reset();
  await page.evaluate(() => navigator.clipboard.writeText('전기차 보조금')).catch(() => {});
  await page.locator('#s-big-topic').click();
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(300);
  check(
    (await page.locator('#s-big-topic').inputValue()) === '전기차 보조금'
      && !(await page.locator('#bulk-box').isVisible()),
    '한 줄짜리 붙여넣기는 예전처럼 그냥 칸에 들어간다 (되려 불편해지면 안 된다)',
  );
  await page.locator('#btn-order').click();
  await page.waitForTimeout(700);
  check(posted.length === 1 && posted[0] === '전기차 보조금', '[확인] 한 건은 그대로 동작한다', JSON.stringify(posted));

  /* ---------- 마지막 그물 ---------- */
  await reset();
  await page.evaluate(() => {
    document.getElementById('s-big-topic').value =
      '2026년 부동산 정책 청년 국가 지원금 전기차 보조금 건강보험 개편 국가기술자격증';
  });
  page.once('dialog', (dialog) => dialog.dismiss());   // [취소] = 여러 줄 칸으로 옮겨줘
  await page.locator('#btn-order').click();
  await page.waitForTimeout(600);
  check(
    posted.length === 0 && await page.locator('#bulk-box').isVisible(),
    '가로채기를 뚫고 한 줄로 뭉개진 긴 주제는 묻고, 취소하면 여러 줄 칸으로 옮긴다',
    `${posted.length}건 나감`,
  );

  await reset();
  await page.evaluate(() => {
    document.getElementById('s-big-topic').value = '2026년 상반기 청년 국가 지원금';
  });
  await page.locator('#btn-order').click();
  await page.waitForTimeout(700);
  check(
    posted.length === 1,
    '멀쩡한 길이의 주제는 묻지 않고 그냥 들어간다 (매번 물으면 귀찮다)',
    JSON.stringify(posted),
  );

  check(errors.length === 0, '대시보드에 자바스크립트 오류가 없다', errors.join(' / '));
} finally {
  await browser.close().catch(() => {});
  server.kill('SIGKILL');
}

console.log(failures ? `\n실패 ${failures}건` : '\n모두 통과했습니다.');
process.exit(failures ? 1 : 0);
