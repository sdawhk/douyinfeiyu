"""Conservative evidence annotations. Never rewrite the original statement."""
import hashlib
import math
import re
from datetime import datetime

VERSION = 'evidence-v3'
HEAD = re.compile(r'(他说|他回|我说|我回|她说|她回)[：:]')
PLAN = re.compile(r'准备|打算|计划|预计|将要|明天.{0,8}(?:去|来|做|看|上)')
HYPOTHESIS = re.compile(r'假如|假设|如果|比如说|例如|设想')
REPORT = re.compile(r'听说|据说|转述|别人说|朋友说|同事说|有人说')
UNCERTAIN = re.compile(r'不确定|好像|可能|大概|也许|看不清|辨认不清')
COMMIT = re.compile(r'约定|说好了|答应|承诺|保证|别忘了')
EMOTION = re.compile(r'难过|开心|高兴|疲惫|好累|疲倦|委屈|害怕|安心|失落|紧张')


def timestamp(value):
    if value is None or value == '':
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if math.isfinite(value):
            return float(value)
        raise ValueError('invalid effective time')
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    raise ValueError('invalid effective time')


def valid_vector(value, dimension=None):
    return (isinstance(value, (list, tuple)) and bool(value)
            and (dimension is None or len(value) == dimension)
            and all(isinstance(x, (int, float)) and not isinstance(x, bool)
                    and math.isfinite(x) for x in value)
            and any(x != 0 for x in value))


def canonical_subject(value):
    value = str(value or '').strip()
    if value in ('owner', 'user', '他', '用户', '本人'):
        return 'owner'
    if value in ('role', 'assistant', '她', '角色'):
        return 'role'
    return value


def subject_of(text, speaker='owner', explicit=None):
    if explicit:
        return canonical_subject(explicit)
    text = text.strip(' \t\n，。；：:【】[]（）“”\"')
    text = re.sub(r'^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*[：:]?\s*', '', text)
    text = re.sub(r'^(?:今天|昨天|中午|上午|下午|晚上|凌晨)\s*[，,:：]?\s*', '', text)
    if re.match(r'^(?:电脑|设备|机器|进程|网络|服务).{0,10}(?:关|断|停).{0,10}我',text):
        return speaker
    if re.match(r'^(?:我|俺)\s*(?:\d{4}\s*年\s*)?\d{1,2}\s*岁', text):
        return speaker
    if re.match(r'^(?:他|用户)\s*(?:\d{4}\s*年\s*)?\d{1,2}\s*岁', text):
        return 'owner'
    if re.match(r'^(?:我|俺)(?:的|在|住|今年|叫|喜欢|爱|不|怕|工作|生日|刚|已经|曾经|正在|给|发|分享|上传)', text):
        return speaker
    if re.match(r'^(?:他|用户)(?:的|在|住|今年|叫|喜欢|爱|不|怕|工作|生日)', text):
        return 'owner'
    if re.match(r'^(?:你|她|assistant|角色)(?:的|在|住|今年|叫|喜欢|爱|不|怕|工作|生日)', text):
        return 'role' if speaker == 'owner' else 'owner'
    match = re.match(r'^([\u4e00-\u9fffA-Za-z]{2,6})(?:住在|任职于|就职于|的生日|喜欢吃|今年)', text)
    return match.group(1) if match else ''


def provenance(row):
    source = str(row.get('source') or '')
    content = str(row.get('content') or '')
    existing = str(row.get('source_kind') or '')
    if existing:
        return existing
    if source == 'image_description' or '图片内容，视觉解读' in content:
        return 'vision'
    if source == 'image_ocr' or '图片文字，自动识别' in content:
        return 'ocr'
    if source in ('transcription', 'asr', 'voice_transcript'):
        return 'transcript'
    if row.get('content_source') in ('generated', 'visual_interpretation') or row.get('mem_type') in ('episode', 'distilled'):
        return 'generated'
    return 'original'


def annotate(row):
    from schema import classify_kind
    text = str(row.get('content') or '')
    marks = list(HEAD.finditer(text))
    ranges = []
    if not marks:
        speaker = canonical_subject(row.get('speaker'))
        if not speaker:
            speaker = 'role' if row.get('source') == 'legacy_memory_md' else 'owner'
        ranges.append((0, len(text), speaker))
    else:
        if marks[0].start():
            ranges.append((0, marks[0].start(), 'unknown'))
        for index, mark in enumerate(marks):
            end = marks[index+1].start() if index+1 < len(marks) else len(text)
            ranges.append((mark.end(), end, 'owner' if mark.group(1) in ('他说','他回','我说') else 'role'))
    facets = []
    for start, end, speaker in ranges:
        for part in re.finditer(r'[^。；;\n]+', text[start:end]):
            lo, hi = start+part.start(), start+part.end()
            body = text[lo:hi]
            mode = ('hypothetical' if HYPOTHESIS.search(body) else 'reported' if REPORT.search(body)
                    else 'planned' if PLAN.search(body) else 'uncertain' if UNCERTAIN.search(body) else 'asserted')
            kinds = [classify_kind(body, str(row.get('source') or ''))]
            if COMMIT.search(body):
                kinds.append('约定')
            if EMOTION.search(body):
                kinds.append('情感')
            facets.append({'start':lo,'end':hi,'speaker':speaker,'subject':subject_of(body,speaker,row.get('subject')),
                           'mode':mode,'kinds':list(dict.fromkeys(kinds))})
    return {'version':VERSION,'content_sha256':hashlib.sha256(text.encode('utf-8')).hexdigest(),
            'source_kind':provenance(row),'facets':facets}


def placeholder(row):
    text = str(row.get('content') or '').strip()
    if not text:
        return True
    text = HEAD.sub('',text).strip(' \n\t：:；;。[]【】')
    return bool(re.fullmatch(r'(?:图片|语音|视频|OCR|转写|识图)(?:内容)?(?:识别|转写|下载)?(?:未识别|未保存|为空|失败|无法读取|不可辨认)?',text,re.I))


def requested_subject(query, rows=()):
    query=re.sub(r'((?:我|你|他|她|用户|assistant))(?:现在|今年|目前|到底|究竟|已经)\s*',r'\1',query)
    actor=re.search(r'(?:^|[，,])\s*(我|你|他|她|用户|assistant)(?=的|在|住|给|发|分享|上传|几|多大|多少岁|岁数|年纪|叫|怕|爱|喜欢|生日|工作|职位|职业)',query)
    if actor:
        return 'role' if actor.group(1) in ('你','她','assistant') else 'owner'
    if re.search(r'(?:我|用户)(?:的|在|住|叫|几|怕|爱|喜欢|生日|工作|人在哪)',query):
        return 'owner'
    if re.search(r'(?:你|assistant)(?:的|在|住|叫|几|怕|爱|喜欢|生日|工作|会|还|能|在线)',query):
        return 'role'
    named=re.match(r'^([\u4e00-\u9fffA-Za-z]{2,6})(?:住哪|在哪(?:工作|上班)|的生日|几岁|叫什么)',query)
    if named:return named.group(1)
    for row in rows:
        subject = canonical_subject(row.get('subject'))
        if subject and subject not in ('owner','role') and subject in query:
            return subject
    return ''


def supports(row, query, *, subject=None):
    """A fact answer needs an applicable clause, not a matching word elsewhere."""
    from slot_check import find_slot, has_evidence
    from recall_engine import is_meta_query
    slot, _ = find_slot(query)
    if not slot or is_meta_query(query):
        return True
    target = canonical_subject(subject) or requested_subject(query,[row])
    meta = annotate(row)
    if (meta['source_kind'] in ('vision','ocr','transcript','generated') or row.get('content_confidence')=='low') and not row.get('user_confirmed'):
        return False
    content = str(row.get('content') or '')
    if slot=='发布记录':
        def explicit_dates(text):
            return {tuple(map(int,m)) for m in re.findall(r'(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?',str(text))}
        asked=explicit_dates(query)
        if asked and not asked.intersection(explicit_dates(content+' '+str(row.get('event_time') or ''))):
            return False
    for facet in meta['facets']:
        if facet['mode'] != 'asserted':
            continue
        if target and facet['subject'] != target:
            continue
        body = content[facet['start']:facet['end']]
        if '?' in body or '？' in body:
            continue
        if has_evidence(slot,[body])[0]:
            return True
    return False


def labels(row):
    meta = annotate(row)
    out = []
    if meta['source_kind'] in ('vision','ocr','transcript','generated'):
        label = {'vision':'视觉解读','ocr':'OCR转写','transcript':'语音转写',
                 'generated':'归纳记录'}[meta['source_kind']]
        if meta['source_kind'] != 'generated':
            label += '，用户已确认' if row.get('user_confirmed') else '，未获用户确认'
        out.append(label)
    if meta['source_kind'] == 'configuration':
        out.append('当前人设配置')
    if row.get('content_confidence')=='low':out.append('低把握记录')
    modes = {facet['mode'] for facet in meta['facets']}
    for mode, label in (('hypothetical','假设'),('reported','转述'),('planned','计划，完成情况未确认'),('uncertain','不确定')):
        if mode in modes:
            out.append(label)
    return out
