// 渲染画风独立于构图 preset；只改画法，不导入 PDF 中不同的人物设定。
export const RENDER_STYLE_VERSION = '2026-11-21-v1';
export const RENDER_STYLES = Object.freeze({
  legacy: { label: '当前半厚涂' },
  gentle_anime: {
    label: '温柔新番',
    quality: '温柔治愈日系新番动画插画，干净纤细线稿，清新配色，轻盈赛璐璐底色与少量柔和过渡，通透而不厚涂',
    face: '细线五官，简洁虹膜高光，肤色通透，阴影轻柔，保持原脸型、半杏眼与五官间距',
    lighting: '柔和自然主光，阴影轻薄，发丝有克制的透光亮边，光线方向服从场景',
    background: '清新日系动画背景，空间层次清楚，远景细节适度简化',
    fabric: '布料用轻薄色块与少量褶线表现，轮廓贴合身体',
    negative: ['厚涂', '粗糙速写线', '厚重黑影', '灰暗压抑色调'],
    conflict: /厚涂|粗糙速写|厚重黑影|rough sketch|heavy black shadow/i
  },
  battle_sketch: {
    label: '战斗速写',
    quality: '日系战斗动画原画质感，松散有力的手绘速写线，动态赛璐璐分块，硬边重阴影，冷灰低饱和色调，保留线条顿挫与粗细变化，禁止厚涂柔光',
    face: '五官用有顿挫的手绘线与硬边阴影塑形，瞳孔高光简洁，保持原脸型、半杏眼与五官间距，不改变表情',
    lighting: '方向明确的戏剧性主光，硬边明暗分区，冷灰暗部，光源服从场景，不用柔光空气刷',
    background: '手绘动画场景，透视明确，远近层次用疏密线条与冷灰块面区分',
    fabric: '布料用利落褶线与硬边明暗色块表现，衣缘贴合身体',
    negative: ['厚涂', '空气刷', '光滑细线', '粉彩', '唯美滤镜'],
    conflict: /厚涂|空气刷|柔光滤镜|粉彩|治愈画风|pastel|soft aesthetic/i
  },
  mono_manga: {
    label: '黑白漫画',
    quality: '纯黑白日系漫画原稿，全画面只用黑白灰，极细锐利墨线，高对比黑白块面，厚实黑影，网点与疏密排线塑形，禁止任何彩色与厚涂渐变',
    face: '锐利细墨线五官，虹膜用墨线与留白高光，肤色用纸白与少量网点，保持原脸型、半杏眼与五官间距',
    lighting: '单一方向的黑白明暗块面，重黑投影与纸白高光，灰阶层次用排线和网点表现，无彩色光源',
    background: '黑白漫画背景，近景墨线明确，远景减少排线密度，空间层次清晰',
    fabric: '衣料与褶皱以墨线、排线和网点表现，深色布面留白高光，衣缘贴合身体',
    negative: ['彩色', '局部彩色', '彩色高光', '厚涂', '空气刷渐变', '模糊墨线'],
    conflict: /彩色|粉彩|暖色光|蓝色光|红色光|水彩|油画|厚涂|colorful|pastel|watercolor/i
  }
});
export const RENDER_STYLE_NAMES = Object.keys(RENDER_STYLES);

export function normalizeRenderStyle(value) {
  const name = String(value ?? '').trim().toLowerCase();
  if (!name || name === 'auto') return 'legacy';
  if (!Object.hasOwn(RENDER_STYLES, name)) throw new Error(`不支持的 renderStyle：${name}`);
  return name;
}

export function assertRenderStyleNotes(renderStyle, text = '') {
  const style = RENDER_STYLES[normalizeRenderStyle(renderStyle)];
  const positiveNotes = String(text).replace(/(?:禁止|不要|不使用|无)(?:任何)?(?:彩色|厚涂|空气刷|粉彩|粗糙速写|厚重黑影)/g, '');
  if (style.conflict?.test(positiveNotes)) {
    throw new Error(`补充描述与“${style.label}”画风冲突，请通过 renderStyle 选择画风`);
  }
}

// 只处理自有分层模板中的已知本色词；源人物定义与元数据保持蓝发蓝瞳。
// 不对用户动作描述做全局替换，也不把源角色定义改成黑发角色。
function monochromeLayer(text) {
  return String(text ?? '')
    .replace(/五官发色瞳色不变/g, '五官与灰阶明度分区不变')
    .replace(/浅蓝灰|浅蓝色|浅蓝|米白色/g, '浅灰')
    .replace(/深海军蓝|深海蓝|纯宝蓝|宝蓝|深蓝色|深蓝|藏青色|藏青|蓝灰/g, '深灰')
    .replace(/棕色|金色/g, '中灰')
    .replace(/脸颊淡粉/g, '脸颊淡网点')
    .replace(/泛红|微红|浅红|脸红|腮红/g, '淡网点')
    .replace(/青色/g, '浅灰')
    .replace(/发色不变|瞳色不变/g, '明度分区不变');
}

export function applyRenderStyleLayers(layers, options = {}) {
  const name = normalizeRenderStyle(options.renderStyle);
  if (name === 'legacy') return layers;
  const style = RENDER_STYLES[name];
  const result = { ...layers };
  const near = options.framing === 'bust';
  result.quality = style.quality;
  result.faceStyle = `${near ? '脸部近景，五官清晰，脸型轮廓完整，' : ''}${style.face}`;
  result.lighting = `${style.lighting}${options.styleNotes ? `，${options.styleNotes}` : ''}`;
  result.background = `${style.background}，${options.backgroundDetail === 'rich' ? '环境细节丰富' : options.backgroundDetail === 'minimal' ? '环境简洁' : '环境细节适中'}`;
  result.keepUnchanged = '参考图只取人物身份、脸型骨相、五官间距、鳍耳发饰与身体比例，不取原图的上色、笔触、光影、姿势和表情，全部按本套画风重绘';
  result.acceptance = near ? '脸未裁切，五官清楚，画法统一' : '脚未裁切，头身比6.5–7，衣缘贴合，画法统一';
  // 已有服装层的材质由调用方替换，不再同时要求半厚涂织理和动画平涂。
  if (options.fabricText) result.clothing = result.clothing.split(options.fabricText).join(style.fabric);
  if (name === 'mono_manga') {
    for (const key of ['character', 'hairstyle', 'vibe', 'expression', 'clothing']) {
      result[key] = monochromeLayer(result[key]);
    }
  }
  return result;
}

const ANIMATION_NEGATIVE_CONFLICTS = new Set(['平涂卡通', '粗描边扁平上色', '无褶皱', '纸片感', '贴图感']);
const MONO_NEGATIVE_CONFLICTS = new Set(['黑发', '换发色', '纸片感', '贴图感']);

export function renderStyleNegativeTerms(terms, renderStyle) {
  const name = normalizeRenderStyle(renderStyle);
  if (name === 'legacy') return terms;
  return terms.filter((term) => !ANIMATION_NEGATIVE_CONFLICTS.has(term)
    && !(name === 'mono_manga' && MONO_NEGATIVE_CONFLICTS.has(term)));
}
