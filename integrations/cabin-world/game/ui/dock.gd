class_name Dock
extends PanelContainer
## The record panel: activity log, items and tools, diary. Everything shown here comes from the host over the link.
##
## INTERFACE: panel messages. Full reference: ../docs/INTERFACES.md section 9.
##   panel.get   game -> host  id (required), panel (required: "usage", "activity", "album", "photo" or "memory"),
##                             who (required for album, photo, memory: "Final01" or "xiaojingyu"), photo (required for photo: the id from album)
##   panel.data  host -> game  id, panel, who, photo, ok, data, error
##   panel.do    game -> host  id (required), action (required: "album.snap", "memory.anchor" or "memory.topics"), who (required),
##                             anchor and approve (memory.anchor), enabled (memory.topics)
##   panel.did   host -> game  id, action, who, ok, data, error
## usage data: products, residents: { Final01, xiaojingyu }, each with usage, foods, bag, life, log, hunger, satiety, likes.
## activity data: residents: { actor: rows of { id, at, action, category, name, detail, status } }, normalized by one host journal.
## album data: photos: rows of { id, atMs, summary, source }, pending: rows of { id, status, progress, summary }, enabled.
## photo data: jpeg, a base64 JPEG.
## memory data: report { events, knowledge, commitments, metrics, anchors }, topics { enabled, scopes }, parts: anchor part id to its name.

const REFRESH_USAGE := 8.0
const REFRESH_ACTIVITY := 15.0
const REFRESH_DETAIL := 8.0
const PHOTO_CACHE := 24
const PHOTO_SOURCES := {"qq": "QQ里拍给别人的", "console": "从这里拍的"}
const PROP_TABS := [["home", "芊夏的小屋"], ["xjhome", "小鲸鱼的小屋"], ["park", "公园"], ["shop", "小卖部"], ["onsen", "汤屋"], ["arcade", "电玩城"], ["life", "生活"], ["album", "相册"], ["memory", "记忆"]]

## [key, name] of each resident, from residents.json.
var RESIDENTS: Array = Residents.people().map(func(p): return [p["key"], p["name"]])
var tab := "log"
var usage := {}
var activity: Array = []
var _font: SystemFont
var _bold: SystemFont
var _top: HBoxContainer
var _bar: HFlowContainer
var _section: VBoxContainer
var _scroll: ScrollContainer
var _list: VBoxContainer
var _collection: ContentList
var resident_activity := {}
var _clock := 0.0
var _next_usage := 0.0
var _next_activity := 0.0
var _seq := 0
var _log_who := "Final01"
var _prop_tab := "home"
const PAGED_PROPS := ["home","xjhome","park","shop","onsen","arcade"]
var _diary_who := "Final01"
var _diary_day := {}
var _signature := ""
var _next_detail := 0.0
var _details := {}
var _who := "Final01"
var _note := ""
var _photos := {}
var _photo_slots := {}
var _photo_asked := {}
var _open_first := false
var _bag_signature := ""
var _next_life := 0.0

func refresh() -> void:
	_next_usage=0
	_next_activity=0
	_next_detail=0
	_ask("world")
	_note="正在刷新近况"

func show_object(scene: String,id: String) -> void:
	for row in WorldData.objects:
		if row.id!=id:continue
		tab="props"
		_prop_tab=str(row.get("space","home"))
		_collection.states["props:"+_prop_tab]={"page":0,"search":row.name,"category":""}
		rebuild()
		return


func _ready() -> void:
	_log_who = str(RESIDENTS[0][0])
	_diary_who = _log_who
	_who = _log_who
	if not WorldData.scenes.has(WorldData.scene_of_space(_prop_tab)):
		for pair in PROP_TABS:
			if WorldData.scene_of_space(pair[0]) == Residents.people()[0]["home"]["scene"]:
				_prop_tab = pair[0]
				break
	_font = SystemFont.new()
	_font.font_names = PackedStringArray(["Microsoft YaHei UI", "Microsoft YaHei", "SimHei"])
	_bold = SystemFont.new()
	_bold.font_names = _font.font_names
	_bold.font_weight = 700
	add_theme_stylebox_override("panel", _box(Hud.PAPER, Hud.WOOD_D, 3, 8))
	var column := VBoxContainer.new()
	column.add_theme_constant_override("separation", 6)
	add_child(column)
	_top = HBoxContainer.new()
	_top.add_theme_constant_override("separation", 4)
	column.add_child(_top)
	_bar = HFlowContainer.new()
	_bar.add_theme_constant_override("h_separation", 4)
	_bar.add_theme_constant_override("v_separation", 4)
	column.add_child(_bar)
	_section = VBoxContainer.new()
	_section.add_theme_constant_override("separation",4)
	column.add_child(_section)
	_scroll = ScrollContainer.new()
	_scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_AUTO
	_scroll.custom_minimum_size = Vector2(0, 40)
	column.add_child(_scroll)
	_list = VBoxContainer.new()
	_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_list.add_theme_constant_override("separation", 5)
	_scroll.add_child(_list)
	_collection = ContentList.new()
	column.add_child(_collection)
	VadsLink.panel_arrived.connect(_on_panel)
	VadsLink.panel_done.connect(_on_done)
	VadsLink.connection_changed.connect(func(_c): _next_usage = 0.0; _next_activity = 0.0; rebuild())
	var args := OS.get_cmdline_user_args()
	var i := args.find("--dock")
	if i >= 0 and i + 1 < args.size():
		tab = args[i + 1]
	i = args.find("--prop-tab")
	if i >= 0 and i + 1 < args.size():
		_prop_tab = args[i + 1]
	_open_first = args.has("--open-first-photo")
	rebuild()


func _process(delta: float) -> void:
	_clock += delta
	if tab=="props" and _prop_tab=="life" and is_visible_in_tree() and _clock>=_next_life:
		_next_life = _clock+REFRESH_USAGE
		rebuild()
	if tab == "bag" and is_visible_in_tree():
		var signature := JSON.stringify(Economy.inventory(_who)) + JSON.stringify(Economy.Social.view(_who))
		if signature != _bag_signature:
			_bag_signature = signature
			rebuild()
	if not VadsLink.connected or not is_visible_in_tree():
		return
	if _clock >= _next_usage:
		_next_usage = _clock + REFRESH_USAGE
		_ask("usage")
	if tab == "log" and _clock >= _next_activity:
		_next_activity = _clock + REFRESH_ACTIVITY
		_ask("activity")
		_ask("world")
	if tab == "props" and _prop_tab in ["album", "memory"] and _clock >= _next_detail:
		_next_detail = _clock + REFRESH_DETAIL
		_ask(_prop_tab, {"who": _who})


func _ask(panel: String, extra := {}) -> void:
	_seq += 1
	VadsLink.send({"type": "panel.get", "id": _seq, "panel": panel}.merged(extra))


func _do(action: String, extra := {}) -> void:
	_seq += 1
	VadsLink.send({"type": "panel.do", "id": _seq, "action": action, "who": _who}.merged(extra))


func _on_done(frame: Dictionary) -> void:
	if str(frame.get("action", "")).begins_with("audio."): return
	var data = frame.get("data")
	if frame.get("ok") != true:
		_note = str(frame.get("error", "没有做成"))
	else:
		_note = str(data.get("message", "")) if data is Dictionary else ""
	_next_detail = 0.0
	rebuild()


func _on_photo(frame: Dictionary) -> void:
	var id := str(frame.get("who", "")) + ":" + str(frame.get("photo", ""))
	_photo_asked.erase(id)
	var slot = _photo_slots.get(id)
	var image := Image.new()
	var data = frame.get("data")
	var made: bool = frame.get("ok") == true and data is Dictionary and image.load_jpg_from_buffer(Marshalls.base64_to_raw(str(data.get("jpeg", "")))) == OK
	if not made:
		if slot is TextureRect and is_instance_valid(slot):
			slot.tooltip_text = "这张读不出来"
		return
	if _photos.size() >= PHOTO_CACHE:
		_photos.clear()
	_photos[id] = ImageTexture.create_from_image(image)
	if slot is TextureRect and is_instance_valid(slot):
		_fill_photo(slot, _photos[id])
		if _open_first:
			_open_first = false
			_open_photo(_photos[id])


func _on_panel(frame: Dictionary) -> void:
	var kind := str(frame.get("panel", ""))
	if kind=="world" and frame.get("data") is Dictionary:
		var meetup=frame.data.get("meetup")
		if meetup is Dictionary:_note="碰面聊天：今天 %s/%s 次%s"%[meetup.get("today",0),meetup.get("maxPerDay",0)," · "+str(meetup.lastError) if meetup.get("lastError") else ""]
		rebuild()
		return
	if kind == "photo":
		_on_photo(frame)
		return
	if kind == "album" or kind == "memory":
		_details[kind + ":" + str(frame.get("who", ""))] = frame["data"] if frame.get("ok") == true and frame.get("data") is Dictionary else {"error": str(frame.get("error", "读不到"))}
	elif frame.get("ok") != true or not frame.get("data") is Dictionary:
		return
	elif kind == "usage":
		usage = frame["data"]
	elif kind == "activity":
		var data: Dictionary = frame["data"]
		resident_activity = data.get("residents",{})
		var rows: Array = []
		rows.append_array(data.get("activity", []))
		rows.append_array(data.get("pluginActivity", []))
		rows.sort_custom(func(a, b): return float(a.get("at", 0)) > float(b.get("at", 0)))
		activity = rows
	# Don't rebuild (and lose the scroll position) unless something changed.
	var key := tab + _log_who + _prop_tab + _diary_who + str(_diary_day) + str(hash(JSON.stringify(usage))) + str(hash(JSON.stringify(resident_activity))) + str(activity.size()) + _who + _note + str(hash(JSON.stringify(_details)))
	if key != _signature:
		_signature = key
		rebuild()


# ---- Small building blocks -------------------------------------------------------

func _box(bg: Color, border: Color, width := 2, pad := 4) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = bg
	s.border_color = border
	s.set_border_width_all(width)
	s.set_content_margin_all(pad)
	return s


func _button(text_of: String, on: bool, action: Callable, parent: Control) -> Button:
	var b := Button.new()
	b.text = text_of
	b.focus_mode = Control.FOCUS_NONE
	b.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	b.add_theme_font_override("font", _font)
	b.add_theme_font_size_override("font_size", 13)
	var face := Hud.WOOD if not on else Hud.PAPER_H
	var ink := Hud.CREAM if not on else Hud.INK
	b.add_theme_stylebox_override("normal", _box(face, Hud.WOOD_D, 2, 4))
	b.add_theme_stylebox_override("hover", _box(Hud.WOOD_L if not on else Hud.PAPER_H, Hud.WOOD_D, 2, 4))
	b.add_theme_stylebox_override("pressed", _box(Hud.WOOD_S if not on else Hud.PAPER_D, Hud.WOOD_D, 2, 4))
	b.add_theme_stylebox_override("disabled", _box(Hud.PAPER_D, Hud.WOOD_L, 2, 4))
	for state in ["font_color", "font_hover_color", "font_pressed_color"]:
		b.add_theme_color_override(state, ink)
	b.add_theme_color_override("font_disabled_color", Hud.INK2)
	b.pressed.connect(action)
	parent.add_child(b)
	return b


func _label(text_of: String, size_of := 13, color := Hud.INK, bold := false) -> Label:
	var l := Label.new()
	l.text = text_of
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	l.add_theme_font_override("font", _bold if bold else _font)
	l.add_theme_font_size_override("font_size", size_of)
	l.add_theme_color_override("font_color", color)
	return l


func _row(title: String, body := "", meta := "") -> void:
	var card := PanelContainer.new()
	card.add_theme_stylebox_override("panel", _box(Hud.PAPER_H, Hud.PAPER_D, 2, 5))
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 1)
	card.add_child(v)
	v.add_child(_label(title, 13, Hud.INK, true))
	if body != "":
		v.add_child(_label(body, 12, Hud.INK2))
	if meta != "":
		v.add_child(_label(meta, 11, Hud.WOOD))
	_list.add_child(card)


func _clear(node: Node) -> void:
	for c in node.get_children():
		node.remove_child(c)
		c.queue_free()


func _when(ms) -> String:
	if ms == null or float(ms) <= 0.0:
		return ""
	var s := Time.get_datetime_string_from_unix_time(int(float(ms) / 1000.0) + 8 * 3600)
	return s.substr(5, 11).replace("T", " ")


func _resident(id: String) -> Dictionary:
	var rows = usage.get("residents")
	var row = rows.get(id) if rows is Dictionary else null
	return row if row is Dictionary else {}


func _change(what: Callable) -> void:
	what.call()
	_next_detail = 0.0
	_note = ""
	_scroll.scroll_vertical = 0
	rebuild()


# ---- Drawing the tabs ---------------------------------------------------------------

func rebuild() -> void:
	_clear(_top)
	_clear(_bar)
	_clear(_list)
	_clear(_section)
	_section.visible = tab=="props" and _prop_tab=="album"
	var collection_view := tab in ["log","bag"] or (tab=="props" and (_prop_tab in PAGED_PROPS or _prop_tab=="album"))
	_collection.visible = collection_view
	_scroll.visible = not collection_view
	_list.size_flags_vertical = Control.SIZE_FILL
	for pair in [["log", "记录"], ["props", "道具"], ["bag", "背包"], ["diary", "日记"]]:
		var id: String = pair[0]
		_button(pair[1], tab == id, func(): _change(func(): tab = id; _next_activity = 0.0), _top)
	if tab not in ["bag", "props"] and not VadsLink.connected and usage.is_empty():
		if collection_view: _collection.present(tab,[],1,"","机器人软件没有连上，暂时看不到这些记录。")
		else: _list.add_child(_label("机器人软件没有连上，暂时看不到这些记录。", 13, Hud.INK2))
		return
	match tab:
		"bag":
			_show_bag()
		"log":
			_show_records()
		"props":
			_build_props()
		"diary":
			_build_diary()


func _log_rows() -> Array:
	return resident_activity.get(_log_who,[])


## Adapters below only supply content. ContentList owns search, filters, sizing and pages.
func _show_records() -> void:
	for person in RESIDENTS:
		var id: String = person[0]
		_button(person[1],_log_who==id,func(): _change(func(): _log_who=id; _next_activity=0),_bar)
	var rows := []
	for event in _log_rows():
		rows.append({"id":event.get("id",""),"title":event.get("name",event.get("action","活动")),"detail":event.get("detail",event.get("text","")),"meta":_when(event.get("at"))+" · "+str(event.get("action","活动"))+" · "+str(event.get("status","")),"category":event.get("category",event.get("action","活动"))})
	var today: Dictionary=_resident(_log_who).get("today",{})
	var summary := "今天 %d 次活动 · 使用 %d 件道具"%[today.get("count",0),today.get("props",0)]
	var here: Dictionary=SharedFeed.presence_now.get(_log_who,{})
	var nearby := PackedStringArray()
	for actor in SharedFeed.presence_now:
		var peer=SharedFeed.presence_now[actor]
		if actor!=_log_who and peer is Dictionary and here.get("space")!=null and peer.get("space")==here.get("space"):nearby.append(str(Residents.person(actor).get("name",actor)))
	if not nearby.is_empty():summary+=" · 身边："+"、".join(nearby)
	_collection.present("activity:"+_log_who,rows,1,summary+("\n"+_note if _note!="" else ""),"还没有关键活动记录。")


func _entry(item: Dictionary, detail: String, meta: String, category: String) -> Dictionary:
	return {"id":item.id,"title":str(item.get("name",item.id)),"detail":_brief(detail),"meta":meta,"category":category,"icon":ItemIcons.texture(str(item.id),str(item.get("name","")),str(item.get("space","")))}


func _show_bag() -> void:
	for person in RESIDENTS:
		var id: String = person[0]
		_button(person[1],_who==id,func(): _change(func(): _who=id),_bar)
	var bag := Economy.inventory(_who)
	var rows := []
	for item in bag.items:
		var category := "可赠送" if item.giftable else "自用"
		rows.append(_entry(item,str(item.get("taste","")),"× %d · %s" % [item.count,category],category))
	_collection.present("bag:"+_who,rows,2,"%s的小背包 · %d/%d 件 · 零花钱 %d" % [_who_name(),bag.used,bag.capacity,bag.coins],"包里还没有东西，购买或收到礼物后会显示在这里。",false)


func _show_objects(space: String) -> void:
	var rows := []
	for item in WorldData.objects.filter(func(row): return row.get("space")==space):
		var used := PackedStringArray()
		var total := 0
		for person in RESIDENTS:
			var count := int(_resident(person[0]).get("usage",{}).get(item.id,{}).get("count",0))
			total += count
			if count>0: used.append("%s %d次" % [person[1],count])
		var entry := _entry(item,str(item.get("description",""))," · ".join(used) if total>0 else "暂无使用记录","道具")
		entry["uses"] = total
		rows.append(entry)
	rows.sort_custom(func(a,b):return a.uses>b.uses if a.uses!=b.uses else str(a.id)<str(b.id))
	_collection.present("props:"+space,rows,2,"","这里还没有道具。",false)


func _show_products() -> void:
	var kinds := {"eat":"食物","drink":"饮料","use":"用品"}
	var rows := []
	for item in Economy.catalog.values():
		rows.append(_entry(item,str(item.get("taste","")),"%d 元" % Economy.price_today(item,Economy.today()),kinds.get(item.get("kind"),"用品")))
	_collection.present("props:shop",rows,2,"","暂无商品",false)


static func _brief(value: String) -> String:
	var first := value.split("\n")[0].split("。")[0].strip_edges()
	return first.left(42) + ("…" if first.length() > 42 else "")


func _build_props() -> void:
	for pair in PROP_TABS:
		var id: String = pair[0]
		if id in PAGED_PROPS and not WorldData.scenes.has(WorldData.scene_of_space(id)): continue
		_button(pair[1], _prop_tab == id, func(): _change(func(): _prop_tab = id), _bar)
	match _prop_tab:
		"shop":
			_show_products()
		"arcade":
			_show_objects("arcade")
		"life":
			_build_life()
		"album":
			_build_album()
		"memory":
			_build_memory()
		_:
			_show_objects(_prop_tab)


func _build_life() -> void:
	_who_buttons()
	for pair in RESIDENTS.filter(func(p): return p[0] == _who):
		var v: Dictionary = _resident(pair[0]).get("life", {})
		var feeling: Dictionary = v.get("feeling", _resident(pair[0]).get("feeling", {}))
		if VadsLink.owns_bodies and Economy.people.has(pair[0]):
			var reading := Economy.reading(pair[0])
			v = reading.get("life",{})
			feeling = reading.get("feeling",{})
		if v.is_empty():
			_row(pair[1], "生活数据尚未同步，连接机器人后自动读取。")
			continue
		var mood: Dictionary = v.get("mood", {})
		_row("%s · %s" % [pair[1], str(mood.get("word", ""))], str(mood.get("cause", "")), "心里想着：" + str(v.get("thought", "")))
		var needs: Dictionary = v.get("needs", {})
		for stat in [["开心", feeling.get("joy")], ["精神", feeling.get("energy")], ["饱腹", feeling.get("satiety")], ["陪伴", needs.get("social")], ["新鲜感", needs.get("fun")], ["水分", feeling.get("hydration")]]:
			var line := HBoxContainer.new()
			_list.add_child(line)
			var name_label := _label(stat[0],12)
			name_label.custom_minimum_size.x=44
			line.add_child(name_label)
			var bar := ProgressBar.new()
			bar.size_flags_horizontal=Control.SIZE_EXPAND_FILL
			bar.custom_minimum_size=Vector2(60,12)
			bar.show_percentage=false
			bar.value=float(stat[1]) if stat[1]!=null else 0
			line.add_child(bar)
			line.add_child(_label(str(roundi(float(stat[1]))) if stat[1]!=null else "—",12))
		var wishes := PackedStringArray()
		for w in v.get("wishes", []):
			wishes.append(("✓ " if w.get("done") == true else "· ") + str(w.get("text", "")) + (" " + str(w["progress"]) if str(w.get("progress", "")) != "" else "") + (" · 昨天没做成" if w.get("carried")==true else ""))
		if not wishes.is_empty():
			_row("今天的心愿", "\n".join(wishes))
		var bond: Dictionary = v.get("bond", {})
		var news: Array = v.get("events", [])
		if not news.is_empty(): _row("今天的新鲜事", "\n".join(PackedStringArray(news)))
		if str(bond.get("with",""))!="":
			var likes := "、".join(PackedStringArray(bond.get("knownLikes",[])))
			_row("和"+str(bond.with), "%s · 亲近度 %s/100\n聊过 %s 次 · 送出 %s · 收到 %s" % [bond.get("word",""),bond.get("closeness","—"),bond.get("talks",0),bond.get("given",0),bond.get("got",0)], "记得对方喜欢："+likes if likes!="" else "")
		var records: Dictionary = v.get("records", {})
		var ach: Array = v.get("achievements", [])
		_row("纪录", "钓到 %d 条%s\n放起风筝 %d 次 · 水漂最多 %d 下\n尝过 %d 种吃的 · 实现 %d 个心愿" % [int(records.get("fishCount", 0)), "，最大 " + str(records["bestFish"]) if str(records.get("bestFish", "")) != "" else "", int(records.get("kite",0)), int(records.get("skipBest",0)), int(records.get("foodsTried", 0)), int(records.get("wishes", 0))])
		if not ach.is_empty(): _row("成就", "、".join(PackedStringArray(ach)))
		var species: Array = records.get("species",[])
		if not species.is_empty(): _row("钓鱼图鉴", "、".join(PackedStringArray(species)))
		var games: Dictionary=records.get("arcade",{})
		var game_names := {"mines":"扫雷","xiangqi":"象棋","snake":"贪吃蛇","blocks":"俄罗斯方块"}
		for game in games:
			var result: Dictionary=games[game]
			_row("电玩战绩 · "+str(game_names.get(game,game)),"玩了 %s 局 · 胜 %s · 负 %s · 平 %s" % [result.get("played",0),result.get("won",0),result.get("lost",0),result.get("draw",0)])


# ---- Album and memory ---------------------------------------------------------------

func _who_buttons(parent: Control = null) -> void:
	if parent==null: parent = _list
	var row := HFlowContainer.new()
	row.add_theme_constant_override("h_separation", 4)
	parent.add_child(row)
	for pair in RESIDENTS:
		var id: String = pair[0]
		_button(pair[1], _who == id, func(): _change(func(): _who = id), row)


func _who_name() -> String:
	return str(Residents.person(_who).get("name", ""))


func _detail(kind: String) -> Dictionary:
	_who_buttons()
	var data = _details.get(kind + ":" + _who)
	if not data is Dictionary:
		_list.add_child(_label("正在读取……", 13, Hud.INK2))
		return {}
	if data.has("error"):
		_list.add_child(_label(str(data["error"]), 13, Hud.INK2))
		return {}
	if _note != "":
		_list.add_child(_label(_note, 12, Hud.WOOD))
	return data


func _build_album() -> void:
	_photo_slots.clear()
	_who_buttons(_section)
	var a = _details.get("album:"+_who)
	if not a is Dictionary or a.has("error"):
		var message := "正在读取……" if VadsLink.connected else "机器人尚未连接，连接后可查看相册。"
		if a is Dictionary: message = str(a.get("error",message))
		_collection.present("album:"+_who,[],1,"",message,false)
		return
	var photos: Array = a.get("photos", [])
	var pending: Array = a.get("pending", [])
	var snap := _button("📷 让%s现在拍一张" % _who_name(), false, func(): _note = "正在叫她拍……"; rebuild(); _do("album.snap"), _section)
	snap.disabled = not VadsLink.connected or a.get("enabled") != true or not pending.is_empty()
	var status := "%s的相册 · %d 张" % [_who_name(), photos.size()]
	if _note!="": status += "\n"+_note
	for job in pending:
		status += "\n正在拍：%s（%d%%）" % [str(job.get("summary", "")), int(job.get("progress", 0))]
	var rows := []
	for p in photos:
		rows.append(p.merged({"title":str(p.get("summary","")),"meta":_when(p.get("atMs"))+" · "+str(PHOTO_SOURCES.get(p.get("source"),"自己拍着玩的"))}))
	_collection.present("album:"+_who,rows,1,status,"还没有照片。可以让她拍下喜欢的瞬间。",false,{"card":_photo_card,"min_height":250.0,"unit":"张"})


func _photo_card(p: Dictionary) -> Control:
	var id := str(p.get("id", ""))
	var cache_key := _who+":"+id
	var card := PanelContainer.new()
	card.clip_contents = true
	card.add_theme_stylebox_override("panel", _box(Hud.PAPER_H, Hud.PAPER_D, 2, 5))
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 3)
	card.add_child(v)
	var pic := TextureRect.new()
	pic.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	pic.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	pic.size_flags_vertical = Control.SIZE_EXPAND_FILL
	pic.mouse_filter = Control.MOUSE_FILTER_PASS
	pic.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	pic.gui_input.connect(func(event: InputEvent):
		if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed and pic.texture:
			_open_photo(pic.texture))
	v.add_child(pic)
	var caption := _label(str(p.get("title",""))+"\n"+str(p.get("meta","")),11,Hud.WOOD)
	caption.max_lines_visible = 2
	caption.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	v.add_child(caption)
	_photo_slots[cache_key] = pic
	if _photos.has(cache_key):
		_fill_photo(pic, _photos[cache_key])
	elif not _photo_asked.has(cache_key):
		_photo_asked[cache_key] = true
		_ask("photo", {"who": _who, "photo": id})
	return card


func _fill_photo(slot: TextureRect, texture_of: Texture2D) -> void:
	slot.texture = texture_of


func _open_photo(texture_of: Texture2D) -> void:
	var layer := CanvasLayer.new()
	layer.layer = 60
	var dim := ColorRect.new()
	dim.color = Color(0, 0, 0, 0.85)
	dim.set_anchors_preset(Control.PRESET_FULL_RECT)
	dim.gui_input.connect(func(event: InputEvent):
		if event is InputEventMouseButton and event.pressed:
			layer.queue_free())
	layer.add_child(dim)
	var pic := TextureRect.new()
	pic.texture = texture_of
	pic.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	pic.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	pic.mouse_filter = Control.MOUSE_FILTER_IGNORE
	pic.set_anchors_preset(Control.PRESET_FULL_RECT)
	dim.add_child(pic)
	add_child(layer)


func _build_memory() -> void:
	var data := _detail("memory")
	if data.is_empty():
		return
	# The new bridge exposes Xiaojingyu's actual memory records separately from
	# the legacy report. Keep those records out of the anchor/topic controls.
	if _who == "xiaojingyu" and data.get("entries") is Array:
		var entries: Array = data.get("entries", [])
		_list.add_child(_label("大肥鱼记住的事", 13, Hud.INK, true))
		if entries.is_empty():
			_list.add_child(_label("目前还没有记忆条目。", 13, Hud.INK2))
			return
		var category_names := {"identity": "身份", "fact": "事实", "event": "经历", "correction": "更正"}
		for entry in entries:
			if not entry is Dictionary:
				continue
			var category := str(entry.get("category", "memory"))
			var title := str(category_names.get(category, "记忆"))
			var body := str(entry.get("text", "")).strip_edges()
			if body == "":
				continue
			var at = entry.get("at")
			var meta := ""
			if at is int or at is float:
				meta = _when(at)
			elif at != null and str(at).strip_edges() != "":
				meta = str(at).strip_edges()
			_row(title, body, meta)
		return
	var r: Dictionary = data.get("report", {})
	var k: Dictionary = r.get("knowledge", {})
	var c: Dictionary = r.get("commitments", {})
	var parts: Dictionary = data.get("parts", {})
	var anchors: Dictionary = r.get("anchors", {})
	_list.add_child(_label("锚点决定她们怎么判断事情，只有你确认了才生效。", 12, Hud.INK2))
	_row("🧠 " + _who_name(), "事件 %d · 热 %d · 温 %d · 冷 %d · 待提起 %d · 已取代 %d" % [int(r.get("events", 0)), int(k.get("hot", 0)), int(k.get("warm", 0)), int(k.get("cold", 0)), int(k.get("pending", 0)), int(k.get("superseded", 0))], "承诺：未完成 %d · 完成 %d · 没做到 %d · 查过原始记录 %d 次" % [int(c.get("open", 0)), int(c.get("fulfilled", 0)), int(c.get("broken", 0)), int(r.get("metrics", {}).get("coldQueries", 0))])
	var confirmed := PackedStringArray()
	for p in anchors.get("confirmed", []):
		confirmed.append(str(parts.get(p, p)))
	_row("已确认的锚点", "、".join(confirmed) if not confirmed.is_empty() else "还没有。确认前不影响她们，人设卡照常生效。")
	var proposals: Array = anchors.get("proposals", [])
	if not proposals.is_empty():
		_list.add_child(_label("等你确认", 13, Hud.INK, true))
	for p in proposals:
		var anchor := str(p.get("id", ""))
		_row(str(parts.get(p.get("part"), p.get("part", ""))), str(p.get("text", "")))
		var choice := HBoxContainer.new()
		choice.add_theme_constant_override("separation", 4)
		_list.add_child(choice)
		for pick in [["确认", true], ["不同意", false]]:
			var yes: bool = pick[1]
			_button(pick[0], false, func(): _do("memory.anchor", {"anchor": anchor, "approve": yes}), choice)
	var topics = data.get("topics")
	if not topics is Dictionary:
		return
	var head := HBoxContainer.new()
	head.add_theme_constant_override("separation", 6)
	_list.add_child(head)
	head.add_child(_label("话题库（测试）", 13, Hud.INK, true))
	var on: bool = topics.get("enabled") == true
	_button("关闭" if on else "打开", false, func(): _do("memory.topics", {"enabled": not on}), head)
	var scopes: Array = topics.get("scopes", [])
	if scopes.is_empty():
		_list.add_child(_label("现在是空的。", 12, Hud.INK2))
	for s in scopes:
		var lines := PackedStringArray()
		for t in s.get("threads", []):
			var ideas := PackedStringArray()
			for i in t.get("ideas", []):
				ideas.append(("⇄" if i.get("blend") == true else "") + str(i.get("text", "")) + ("（聊过）" if i.get("used") == true else ""))
			lines.append(("▶ " if t.get("current") == true else "　") + str(t.get("topic", "")) + (" → " + "、".join(ideas) if not ideas.is_empty() else ""))
		_row(str(s.get("name", s.get("id", ""))), "\n".join(lines) if not lines.is_empty() else "—")


func _diary_rows(who: String) -> Array:
	var rows: Array = []
	var seen := {}
	var life = _resident(who).get("life", {})
	for r in (life.get("diary", []) if life is Dictionary else []):
		var day := str(r.get("day", ""))
		if day != "" and str(r.get("text", "")).strip_edges() != "" and not seen.has(day):
			seen[day] = true
			rows.append(r)
	rows.sort_custom(func(a, b): return str(a["day"]) > str(b["day"]))
	return rows


func _build_diary() -> void:
	for pair in RESIDENTS:
		var id: String = pair[0]
		_button(pair[1], _diary_who == id, func(): _change(func(): _diary_who = id), _bar)
	var rows := _diary_rows(_diary_who)
	if rows.is_empty():
		_list.add_child(_label("她还没有写下日记。这里只展示本人写下的文字。", 13, Hud.INK2))
		return
	var chosen := str(_diary_day.get(_diary_who, rows[0]["day"]))
	var index := 0
	for i in rows.size():
		if rows[i]["day"] == chosen:
			index = i
	var older := _button("前一天", false, func(): _change(func(): _diary_day[_diary_who] = rows[index + 1]["day"]), _bar)
	older.disabled = index >= rows.size() - 1
	var newer := _button("后一天", false, func(): _change(func(): _diary_day[_diary_who] = rows[index - 1]["day"]), _bar)
	newer.disabled = index <= 0
	var row: Dictionary = rows[index]
	_list.add_child(_label("%s · 已保存 %d 天" % [str(row["day"]), rows.size()], 13, Hud.WOOD, true))
	_list.add_child(_label(str(row["text"]), 13, Hud.INK))
