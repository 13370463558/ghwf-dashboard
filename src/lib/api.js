// 前端 API 封装：统一处理 401 → 触发登出
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    throw new ApiError('网络错误，请稍后重试', 0);
  }

  if (res.status === 401) {
    if (onUnauthorized) onUnauthorized();
    throw new ApiError('未登录或会话已过期', 401);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(data?.error || `请求失败 (${res.status})`, res.status);
  }
  return data;
}

export const api = {
  login: (password, remember) =>
    request('/api/login', { method: 'POST', body: JSON.stringify({ password, remember }) }),
  logout: () => request('/api/logout', { method: 'POST' }),
  repos: () => request('/api/repos'),
  reposAll: () => request('/api/repos?all=1'),
  workflows: (repo) => request(`/api/workflows?repo=${encodeURIComponent(repo)}`),
  groups: () => request('/api/groups'),
  saveGroups: (data) => request('/api/groups', { method: 'PUT', body: JSON.stringify(data) }),
  dispatchWorkflow: (repo, workflowId, ref) =>
    request('/api/workflowDispatch', {
      method: 'POST',
      body: JSON.stringify({ repo, workflowId, ref }),
    }),
};
