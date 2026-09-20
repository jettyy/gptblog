import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..', '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const THUMB_DIR = path.join(DATA_DIR, 'thumbnails');
export const OUTPUT_DIR = path.join(DATA_DIR, 'posts');
export const EXAMPLE_DIR = path.join(DATA_DIR, 'examples');
export const LOG_DIR = path.join(DATA_DIR, 'logs');

// 네이버는 REST API 로 글을 넣을 수 없어 실제 브라우저를 쓴다.
// 로그인 세션은 프로필 폴더에 남고, 자동화가 깨지면 화면을 찍어 둔다.
export const SHOT_DIR = path.join(DATA_DIR, 'screenshots');
export const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');

/*
 * ChatGPT 구독 계정 세션은 **네이버와 다른 프로필**에 담는다.
 * 한 프로필에 둘을 같이 넣으면 한쪽을 확인하려고 브라우저를 다시 열 때
 * 다른 쪽 로그인이 풀린다.
 */
export const CHATGPT_PROFILE_DIR = path.join(DATA_DIR, 'chatgpt-profile');

export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
export const HISTORY_FILE = path.join(DATA_DIR, 'topic-history.json');
export const REQUESTS_FILE = path.join(DATA_DIR, 'requests.json');
export const SESSION_FILE = path.join(DATA_DIR, 'naver-session.json');
export const STORAGE_FILE = path.join(DATA_DIR, 'naver-cookies.json');
export const CHATGPT_SESSION_FILE = path.join(DATA_DIR, 'chatgpt-session.json');
export const CHATGPT_STORAGE_FILE = path.join(DATA_DIR, 'chatgpt-cookies.json');

export function ensureDirs() {
  for (const dir of [DATA_DIR, THUMB_DIR, OUTPUT_DIR, EXAMPLE_DIR, LOG_DIR, SHOT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
