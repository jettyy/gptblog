/**
 * 대시보드 드롭다운에 띄울 모델 목록.
 * 고른 값이 codex CLI 의 --model 에 그대로 넘어간다.
 *
 * ChatGPT 구독 등급(Plus / Pro / Business)에 따라 쓸 수 없는 모델이 있고,
 * codex CLI 판이 낮으면 이름 자체를 모를 수도 있다. 그 경우 CLI 가 오류를 내므로
 * 대시보드에서 다른 모델로 바꾸거나 [직접 입력…] 으로 정확한 이름을 적으면 된다.
 *
 * 그래서 **기본값은 비워 둔다.** 비워 두면 CLI 가 로그인한 계정에서
 * 쓸 수 있는 모델을 알아서 고르기 때문에, 이름이 바뀌어도 그대로 돌아간다.
 */
export const MODELS = [
  {
    id: '',
    label: '기본값 (codex CLI 설정을 따름)',
    note: '지정하지 않으면 CLI 가 구독 계정에서 쓸 수 있는 모델을 알아서 고릅니다. 가장 안전합니다.',
  },
  {
    id: 'gpt-5.1-codex',
    label: 'GPT-5.1 Codex — 균형 (권장)',
    note: '정보성 글 길이를 안정적으로 채우면서 속도도 쓸 만합니다. 긴 JSON 을 잘 지킵니다.',
  },
  {
    id: 'gpt-5.1-codex-max',
    label: 'GPT-5.1 Codex Max — 가장 똑똑함 (글 품질 우선)',
    note: '1,800자 이상 긴 글에서 문체와 구조를 가장 잘 지킵니다. 대신 느리고 한도를 빨리 씁니다.',
  },
  {
    id: 'gpt-5.1-codex-mini',
    label: 'GPT-5.1 Codex Mini — 가장 빠름',
    note: '빠르고 한도를 덜 쓰지만, 1,800자 + 표 + 항목별 상세를 한 번에 채우기엔 약합니다.',
  },
  {
    id: 'gpt-5.1',
    label: 'GPT-5.1 — 범용 모델',
    note: 'Codex 계열이 막혔을 때의 대안입니다. 글쓰기 자체는 이쪽도 잘합니다.',
  },
  {
    id: 'gpt-5-codex',
    label: 'GPT-5 Codex — 이전 세대',
    note: 'CLI 판이 낮아 5.1 을 모를 때의 대안입니다.',
  },
];

export const MODEL_IDS = new Set(MODELS.map((model) => model.id).filter(Boolean));

/**
 * chatgpt.com 화면(웹 방식)에서 고를 모델.
 * 주소의 ?model= 값으로 넘어간다. CLI 쪽 이름과 표기가 달라서 따로 둔다.
 */
export const WEB_MODELS = [
  { id: '', label: '기본값 (계정에서 마지막으로 쓴 모델)', note: '비워 두는 것이 가장 안전합니다.' },
  { id: 'gpt-5-1', label: 'GPT-5.1', note: '화면에서 고를 수 있는 기본 모델입니다.' },
  { id: 'gpt-5-1-thinking', label: 'GPT-5.1 Thinking', note: '더 오래 생각합니다. 긴 글에 유리하지만 느립니다.' },
  { id: 'auto', label: 'Auto', note: 'ChatGPT 가 알아서 고릅니다.' },
];

/** 사람이 읽을 이름. 기록해둔 모델 ID 를 대시보드에 표시할 때 쓴다. */
export function modelLabel(id) {
  if (!id) return '기본값';
  const known = MODELS.find((model) => model.id === id)
    || WEB_MODELS.find((model) => model.id === id);
  if (known) return known.label.split(' — ')[0];
  return id;
}
