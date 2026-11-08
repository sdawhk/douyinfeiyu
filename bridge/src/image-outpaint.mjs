// 扩图兜底：百炼万相通用图像编辑 wanx2.1-imageedit（华北2 北京）。
// 2026-11 核查：旧的 image-out-painting / services/aigc/image2image/out-painting 已下线，
// 调用直接 404 Model not exist；现网扩图走 image-synthesis + function=expand。
// 只在出图人物占比超标时调用；失败不抛给上层，返回 {ok:false} 让调用方发原图。
export const OUTPAINT_MODEL = 'wanx2.1-imageedit';
// expand 必须带 prompt，否则任务会以 InvalidParameter 失败。
export const OUTPAINT_PROMPT = '补全延伸的背景、地面与光影，保持人物外观、服装和画风一致，不要新增人物或改变构图主体';
// 扩图按输出画幅计费，这里取保守值，只用于日志与 meta，不做结算。
export const OUTPAINT_COST_CNY = 0.18;

function endpointOf(baseUrl) {
  return `${String(baseUrl || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/+$/, '')}/services/aigc/image2image/image-synthesis`;
}

function taskEndpointOf(baseUrl, taskId) {
  return `${String(baseUrl || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/+$/, '')}/tasks/${taskId}`;
}

async function jsonOrThrow(response, label) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const code = String(data?.code || data?.output?.code || '');
    const message = String(data?.message || data?.output?.message || '').slice(0, 160);
    const error = new Error(`${label} HTTP ${response.status}${code ? ` [${code}]` : ''}${message ? `: ${message}` : ''}`);
    error.status = response.status;
    error.providerCode = code;
    throw error;
  }
  return data || {};
}

async function downloadImage(url, fetchImpl, timeoutMs) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`outpaint download HTTP ${response.status}`);
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mime: String(response.headers?.get?.('content-type') || 'image/png').split(';')[0]
  };
}

/** 像素偏移换算成接口的扩展倍数（1.0–2.0，1.0 表示这一侧不扩）。 */
function scaleOf(offset, size) {
  const raw = 1 + Number(offset || 0) / Math.max(1, Number(size) || 1);
  return Math.min(2, Math.max(1, Number(raw.toFixed(4))));
}

/**
 * 调百炼扩图：异步任务 → 轮询 → 下载结果。
 * @returns {Promise<{ok:true, buffer:Buffer, mime:string, taskId:string, ms:number, requestId:string}>}
 *          失败时抛出 Error（由调用方捕获并记录，不阻塞出图）。
 */
export async function outpaintImage({
  buffer,
  mime = 'image/png',
  width = 0,
  height = 0,
  baseUrl = 'https://dashscope.aliyuncs.com/api/v1',
  apiKey = '',
  topOffset = 0,
  bottomOffset = 0,
  prompt = OUTPAINT_PROMPT,
  model = OUTPAINT_MODEL,
  timeoutMs = 120_000,
  pollMs = 2_000,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  if (!apiKey) throw new Error('扩图缺少 API Key');
  if (!buffer?.length) throw new Error('扩图为空');
  if (!width || !height) throw new Error('扩图缺少原图尺寸');
  const started = Date.now();
  const headers = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    // 图像编辑只支持异步任务，缺这个头会直接报同步调用不支持。
    'X-DashScope-Async': 'enable'
  };
  const createResponse = await fetchImpl(endpointOf(baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      input: {
        function: 'expand',
        prompt,
        base_image_url: `data:${mime};base64,${buffer.toString('base64')}`
      },
      parameters: {
        top_scale: scaleOf(topOffset, height),
        bottom_scale: scaleOf(bottomOffset, height),
        left_scale: 1,
        right_scale: 1,
        n: 1
      }
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const created = await jsonOrThrow(createResponse, 'outpaint create');
  const taskId = String(created?.output?.task_id || '');
  const requestId = String(created?.request_id || '');
  if (!taskId) throw new Error('扩图未返回 task_id');

  let status = String(created?.output?.task_status || 'PENDING');
  let lastOutput = created?.output || {};
  while (status === 'PENDING' || status === 'RUNNING') {
    if (Date.now() - started > timeoutMs) throw new Error(`扩图超时（${timeoutMs}ms）`);
    await sleep(pollMs);
    const response = await fetchImpl(taskEndpointOf(baseUrl, taskId), {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await jsonOrThrow(response, 'outpaint poll');
    lastOutput = data?.output || {};
    status = String(lastOutput.task_status || 'UNKNOWN');
  }
  if (status !== 'SUCCEEDED') {
    const error = new Error(`扩图任务 ${status}${lastOutput.message ? `：${lastOutput.message}` : ''}`);
    error.providerCode = String(lastOutput.code || status);
    throw error;
  }
  // 官方返回 output.results[0].url；旧版字段 output_image_url 也兼容。
  const imageUrl = String(lastOutput.results?.[0]?.url || lastOutput.output_image_url || '');
  if (!imageUrl) throw new Error('扩图成功但没有返回图片地址');
  const image = await downloadImage(imageUrl, fetchImpl, timeoutMs);
  return {
    ok: true,
    buffer: image.buffer,
    mime: image.mime,
    taskId,
    requestId,
    ms: Date.now() - started
  };
}
