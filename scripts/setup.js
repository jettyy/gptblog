import { prepareBrowser } from '../src/lib/playwright.js';
import { checkChatGpt } from '../src/ai/chatgpt.js';
import { readSessionInfo } from '../src/naver/browser.js';
import { readChatGptSession } from '../src/ai/session.js';
import { getSettings } from '../src/lib/settings.js';

console.log('지피티러시 준비 상태를 확인합니다.\n');

const { chatgpt: ai, image } = getSettings();

const cli = await checkChatGpt();
console.log(cli.ok
  ? `[확인] 글쓰기 AI: ${cli.version}`
  : `[실패] 글쓰기 AI: ${cli.message}\n`
    + "       npm install -g @openai/codex 로 설치한 뒤 'codex login' 으로 "
    + 'ChatGPT 구독 계정에 로그인하세요.\n'
    + '       CLI 를 깔 수 없으면 대시보드 설정에서 글쓰기 방식을 "웹" 으로 바꾸세요.');

try {
  const { label } = await prepareBrowser();
  console.log(`[확인] 브라우저: ${label}`);
} catch (error) {
  console.log(`[실패] 브라우저 준비 실패: ${error.message}`);
}

// 여기서 브라우저를 띄워 세션을 확인하지는 않는다.
// 로그인할 때와 다른 모드로 프로필을 다시 열면 세션이 끊기는 일이 있다.
const session = readSessionInfo();
console.log(session.loggedIn
  ? `[확인] 네이버 세션 있음${session.blogId ? ` · ${session.blogId}` : ' (블로그 아이디 미확인)'}`
  : '[대기] 네이버 로그인이 아직 없습니다. 대시보드 1번 칸에서 로그인하세요.');

/*
 * ChatGPT 브라우저 세션은 **그림을 만들 때와 글쓰기를 웹 방식으로 쓸 때** 필요하다.
 * 둘 다 안 쓰면 없어도 아무 문제가 없으니 재촉하지 않는다.
 */
const ai_session = readChatGptSession();
const needsWeb = image.enabled || ai.engine === 'web';
if (ai_session.loggedIn) {
  console.log(`[확인] ChatGPT 세션 있음${ai_session.plan ? ` · ${ai_session.plan}` : ''}`);
} else if (needsWeb) {
  console.log(
    '[대기] ChatGPT 로그인이 아직 없습니다. 대시보드 1번 칸에서 '
    + '[ChatGPT 로그인 창 열기] 를 누르세요.\n'
    + `       ${image.enabled ? '썸네일 이미지 생성' : '웹 방식 글쓰기'}에 필요합니다.`,
  );
} else {
  console.log(
    '[건너뜀] ChatGPT 브라우저 로그인은 지금 설정에서는 필요하지 않습니다. '
    + '(썸네일 이미지 생성을 켜면 필요해집니다)',
  );
}

console.log('\n준비가 끝났으면 npm start 로 대시보드를 실행하고, 2번 칸에 큰 주제와 개수를 넣으세요.');
