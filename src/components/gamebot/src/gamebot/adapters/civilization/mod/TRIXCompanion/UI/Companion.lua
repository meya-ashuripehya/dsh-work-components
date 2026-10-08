-- 游戏内陪玩面板。按钮走 LuaEvents，跨上下文消息放在 ExposedMembers。
-- UI 不执行游戏动作，批准只写入收件箱。

local m_seen = 0
local m_bubbles = nil
local m_proposal = ""
local m_lines = {}
local m_collapsed = false
local m_paused = false
local DEFAULT_W = 420
local DEFAULT_H = 560
local MIN_W = 320
local MIN_H = 280
local m_expandedHeight = DEFAULT_H
local m_positioned = false
local m_launchAttached = false
local m_titleDragging = false
local m_resizeDragging = false
local m_dragMouseX = 0
local m_dragMouseY = 0
local m_dragPanelX = 0
local m_dragPanelY = 0
local m_dragWidth = DEFAULT_W
local m_dragHeight = DEFAULT_H

local function EnsureBus()
    local bus = ExposedMembers.TRIXCompanion or {
        ready = false,
        paused = false,
        inbox = {},
        outbox = {},
        seq = 0,
    }
    bus.inbox = bus.inbox or {}
    bus.outbox = bus.outbox or {}
    bus.seq = bus.seq or 0
    bus.ready = true
    ExposedMembers.TRIXCompanion = bus
    return bus
end

local function Clip(text, limit)
    text = tostring(text or "")
    if #text <= limit then
        return text
    end
    local cut = limit
    while cut > 1 do
        local byte = string.byte(text, cut)
        if byte < 128 or byte >= 192 then
            break
        end
        cut = cut - 1
    end
    return string.sub(text, 1, cut - 1) .. "…"
end

local function Trim(text)
    return Clip(text, 400)
end

local function Normalize(text)
    text = tostring(text or "")
    text = string.gsub(text, "\r\n", "\n")
    text = string.gsub(text, "\r", "\n")
    text = string.gsub(text, "\\n", "\n")
    return text
end

local function DisplayText(text)
    text = Normalize(text)
    text = string.gsub(text, "%[", "［")
    text = string.gsub(text, "%]", "］")
    text = string.gsub(text, "\n", "[NEWLINE]")
    return text
end

local function Measure(text, wrap)
    local lines = 1
    local width = 0
    local i = 1
    local raw = Normalize(text)
    while i <= #raw do
        local byte = string.byte(raw, i)
        local size = 1
        if byte >= 240 then
            size = 4
        elseif byte >= 224 then
            size = 3
        elseif byte >= 192 then
            size = 2
        end
        if byte == 10 then
            lines = lines + 1
            width = 0
        else
            local advance = 8
            if size > 1 then
                advance = 16
            end
            width = width + advance
            if width > wrap then
                lines = lines + 1
                width = advance
            end
        end
        i = i + size
    end
    return lines * 22
end

local function Bubbles()
    if Controls.LogStack == nil then
        return nil
    end
    if m_bubbles == nil then
        m_bubbles = InstanceManager:new("ChatBubble", "BubbleRoot", Controls.LogStack)
    end
    return m_bubbles
end

local function LayoutBubble(instance, plain, alignRight)
    local rootW = Controls.LogScroll:GetSizeX() - 18
    if rootW < 160 then
        rootW = 280
    end
    local wrap = math.max(140, rootW - 16)
    local textW = wrap - 16
    local textH = Measure(plain, textW)
    instance.BubbleText:SetWrapWidth(textW)
    instance.BubbleText:SetText(DisplayText(plain))
    instance.BubbleText:SetSizeVal(textW, textH)
    local plateW = wrap
    local plateH = textH + 12
    instance.BubblePlate:SetSizeVal(plateW, plateH)
    instance.BubbleRoot:SetSizeVal(rootW, plateH + 2)
    local x = 0
    if alignRight then
        x = math.max(0, rootW - plateW)
    end
    instance.BubblePlate:SetOffsetVal(x, 0)
end

local function Render()
    local bubbles = Bubbles()
    if bubbles == nil or Controls.LogScroll == nil then
        return
    end
    bubbles:ResetInstances()
    for _, entry in ipairs(m_lines) do
        local instance = bubbles:GetInstance()
        local speaker = tostring(entry.speaker or "")
        local plain = tostring(entry.text or "")
        if speaker ~= "" then
            plain = speaker .. "：\n" .. plain
        end
        LayoutBubble(instance, plain, speaker == "我")
    end
    Controls.LogStack:CalculateSize()
    Controls.LogScroll:CalculateInternalSize()
    if Controls.LogScroll.SetScrollValue ~= nil then
        Controls.LogScroll:SetScrollValue(1)
    end
end

local function Append(speaker, text)
    local line = Clip(text, 12000)
    if line == "" then
        return
    end
    table.insert(m_lines, { speaker = speaker, text = line })
    while #m_lines > 40 do
        table.remove(m_lines, 1)
    end
    Render()
end

local function Push(kind, text, proposalId)
    local bus = EnsureBus()
    bus.seq = (bus.seq or 0) + 1
    table.insert(bus.inbox, {
        id = bus.seq,
        kind = kind,
        text = Trim(text),
        proposal_id = proposalId or "",
    })
    while #bus.inbox > 30 do
        table.remove(bus.inbox, 1)
    end
    if kind == "pause" then
        bus.paused = true
    elseif kind == "resume" then
        bus.paused = false
    end
    ExposedMembers.TRIXCompanion = bus
end

function OnCompanionSend(text)
    Append("我", text)
    Push("chat", text, "")
end
LuaEvents.TRIXCompanion_Send.Add(OnCompanionSend)

function OnCompanionAnalyze()
    Push("analyze", "", "")
    Append("系统", "已请求分析当前局面")
end
LuaEvents.TRIXCompanion_Analyze.Add(OnCompanionAnalyze)

function OnCompanionApprove(proposalId)
    Push("approve", "", proposalId)
    Append("系统", "已确认操作")
    Controls.ApproveButton:SetHide(true)
    Controls.RejectButton:SetHide(true)
    m_proposal = ""
end
LuaEvents.TRIXCompanion_Approve.Add(OnCompanionApprove)

function OnCompanionReject(proposalId)
    Push("reject", "", proposalId)
    Append("系统", "已拒绝操作")
    Controls.ApproveButton:SetHide(true)
    Controls.RejectButton:SetHide(true)
    m_proposal = ""
end
LuaEvents.TRIXCompanion_Reject.Add(OnCompanionReject)

local function ShowProposal(item)
    m_proposal = tostring(item.proposal_id or "")
    local summary = tostring(item.tool_name or "操作") .. " " .. tostring(item.arguments_json or "")
    local impact = tostring(item.impact or item.text or "")
    Controls.ProposalText:SetText("待确认：" .. DisplayText(summary) .. "[NEWLINE]" .. DisplayText(impact))
    local pending = item.status == nil or item.status == "" or item.status == "pending"
    Controls.ApproveButton:SetHide(not pending or m_proposal == "")
    Controls.RejectButton:SetHide(not pending or m_proposal == "")
end

local function Apply(item)
    local kind = tostring(item.kind or "")
    if kind == "message" then
        Append("陪玩", item.text)
        Controls.StatusText:SetText("陪玩在线")
    elseif kind == "proposal" then
        ShowProposal(item)
        Append("陪玩", "有一个操作等待确认")
    elseif kind == "proposal_update" then
        Append("系统", tostring(item.status or "") .. " " .. tostring(item.text or ""))
        if tostring(item.proposal_id or "") == m_proposal then
            Controls.ApproveButton:SetHide(true)
            Controls.RejectButton:SetHide(true)
            Controls.ProposalText:SetText("")
            m_proposal = ""
        end
    elseif kind == "pause" then
        m_paused = true
        Controls.PauseLabel:SetText("继续")
        Controls.StatusText:SetText("已暂停")
    elseif kind == "resume" then
        m_paused = false
        Controls.PauseLabel:SetText("暂停")
        Controls.StatusText:SetText("陪玩在线")
    end
end

function PullOutbox()
    local bus = EnsureBus()
    for _, item in ipairs(bus.outbox or {}) do
        local id = tonumber(item.id) or 0
        if id > m_seen then
            Apply(item)
            m_seen = id
        end
    end
end

function OnSendClicked()
    local text = Trim(Controls.Input:GetText())
    if text == "" then
        return
    end
    Controls.Input:SetText("")
    LuaEvents.TRIXCompanion_Send(text)
end

function OnAnalyzeClicked()
    LuaEvents.TRIXCompanion_Analyze()
end

function OnApproveClicked()
    if m_proposal ~= "" then
        LuaEvents.TRIXCompanion_Approve(m_proposal)
    end
end

function OnRejectClicked()
    if m_proposal ~= "" then
        LuaEvents.TRIXCompanion_Reject(m_proposal)
    end
end

function OnPauseClicked()
    if m_paused then
        m_paused = false
        Push("resume", "", "")
        Controls.PauseLabel:SetText("暂停")
    else
        m_paused = true
        Push("pause", "", "")
        Controls.PauseLabel:SetText("继续")
    end
end

function OnFoldClicked()
    m_collapsed = not m_collapsed
    Controls.Body:SetHide(m_collapsed)
    Controls.StatusText:SetHide(m_collapsed)
    Controls.ResizeGrip:SetHide(m_collapsed)
    Controls.FoldLabel:SetText(m_collapsed and "展开" or "收起")
    local width = Controls.Panel:GetSizeX()
    if m_collapsed then
        m_expandedHeight = Controls.Panel:GetSizeY()
        ApplyChrome(width, 108)
    else
        ApplyChrome(width, m_expandedHeight)
    end
end

function OnCloseClicked()
    Controls.Panel:SetHide(true)
end

function OnLaunchClicked()
    if Controls.Panel:IsHidden() then
        ShowPanel()
    else
        OnCloseClicked()
    end
end

function ArmPoll()
    if Controls.PollAnim.SetToBeginning then
        Controls.PollAnim:SetToBeginning()
    end
    Controls.PollAnim:Play()
end

local m_wakeReason = nil

local function IsLocal(playerID)
    if playerID == nil then
        return true
    end
    if Game == nil or type(Game.GetLocalPlayer) ~= "function" then
        return true
    end
    local localID = Game.GetLocalPlayer()
    if localID == nil or localID < 0 then
        return true
    end
    return playerID == localID
end

local function Wake(reason)
    if m_paused then
        return
    end
    m_wakeReason = reason
end

local function OnPlayerAction(reason)
    return function(playerID)
        if IsLocal(playerID) then
            Wake(reason)
        end
        PullOutbox()
    end
end

local function BindAction(eventName, reason)
    pcall(function()
        Events[eventName].Add(OnPlayerAction(reason))
    end)
end

function OnPollEnd()
    if m_wakeReason and not m_paused then
        Push("activity", m_wakeReason, "")
        m_wakeReason = nil
    end
    PullOutbox()
    ArmPoll()
end

local function Clamp(value, low, high)
    if value < low then
        return low
    end
    if value > high then
        return high
    end
    return value
end

function ApplyChrome(width, height)
    local inset = 28
    Controls.Panel:SetSizeVal(width, height)
    Controls.Background:SetSizeVal(width, height)
    local innerW = math.max(160, width - inset * 2)
    local innerH = math.max(40, height - inset * 2)
    Controls.Inner:SetSizeVal(innerW, innerH)
    Controls.TitleBar:SetSizeVal(innerW - 24, 28)
    if m_collapsed then
        return
    end
    local bodyWidth = innerW - 24
    local bodyHeight = innerH - 76
    if bodyHeight < 120 then
        bodyHeight = 120
    end
    Controls.Body:SetSizeVal(bodyWidth, bodyHeight)
    local logHeight = bodyHeight - 156
    if logHeight < 48 then
        logHeight = 48
    end
    Controls.LogScroll:SetSizeVal(bodyWidth - 8, logHeight)
    if Controls.LogStack ~= nil then
        Controls.LogStack:SetSizeX(bodyWidth - 26)
    end
    Render()
    Controls.ProposalText:SetSizeVal(bodyWidth - 8, 36)
    Controls.ProposalText:SetWrapWidth(bodyWidth - 16)
    Controls.InputFrame:SetSizeX(bodyWidth - 88)
    Controls.Input:SetSizeX(bodyWidth - 104)
end

function PlacePanel()
    local width, height = UIManager:GetScreenSizeVal()
    if width < 200 or height < 200 then
        return false
    end
    ApplyChrome(DEFAULT_W, DEFAULT_H)
    local x = width - DEFAULT_W - 18
    local y = math.floor((height - DEFAULT_H) / 2)
    Controls.Panel:SetOffsetVal(Clamp(x, 8, width - 80), Clamp(y, 8, height - 48))
    return true
end

function PaintText()
    local function paint(control, text)
        if control ~= nil and control.SetText ~= nil then
            control:SetText(text)
        end
    end
    paint(Controls.Title, "TRIX 陪玩")
    local status = Controls.StatusText:GetText()
    if status == nil or status == "" or status == "..." then
        paint(Controls.StatusText, "等待连接")
    end
    local fold = m_collapsed and "展开" or "收起"
    paint(Controls.FoldLabel, fold)
    paint(Controls.FoldButton, fold)
    paint(Controls.CloseLabel, "关闭")
    paint(Controls.CloseButton, "关闭")
    paint(Controls.SendLabel, "发送")
    paint(Controls.SendButton, "发送")
    paint(Controls.AnalyzeLabel, "分析当前局面")
    paint(Controls.AnalyzeButton, "分析当前局面")
    local pause = m_paused and "继续" or "暂停"
    paint(Controls.PauseLabel, pause)
    paint(Controls.PauseButton, pause)
    paint(Controls.ApproveLabel, "批准")
    paint(Controls.RejectLabel, "拒绝")
    if #m_lines == 0 then
        Append("系统", "面板已加载。连接 GAMEBOT 后即可聊天。")
    end
end

function ShowPanel()
    ContextPtr:SetHide(false)
    Controls.Panel:SetHide(false)
    if not m_positioned then
        local ok = pcall(PlacePanel)
        m_positioned = ok
    end
    PaintText()
    print("TRIX Companion panel shown")
end

function OnTitleDrag()
    local mouseX, mouseY = UIManager:GetMousePos()
    if not m_titleDragging then
        m_titleDragging = true
        m_dragMouseX = mouseX
        m_dragMouseY = mouseY
        m_dragPanelX, m_dragPanelY = Controls.Panel:GetOffsetVal()
    end
    local screenW, screenH = UIManager:GetScreenSizeVal()
    local x = m_dragPanelX + (mouseX - m_dragMouseX)
    local y = m_dragPanelY + (mouseY - m_dragMouseY)
    Controls.Panel:SetOffsetVal(Clamp(x, 0, screenW - 80), Clamp(y, 0, screenH - 40))
    m_positioned = true
    LuaEvents.Tutorial_DisableMapDrag(true)
end

function OnResizeDrag()
    if m_collapsed then
        return
    end
    local mouseX, mouseY = UIManager:GetMousePos()
    if not m_resizeDragging then
        m_resizeDragging = true
        m_dragMouseX = mouseX
        m_dragMouseY = mouseY
        m_dragWidth = Controls.Panel:GetSizeX()
        m_dragHeight = Controls.Panel:GetSizeY()
    end
    local screenW, screenH = UIManager:GetScreenSizeVal()
    local panelX, panelY = Controls.Panel:GetOffsetVal()
    local width = Clamp(m_dragWidth + (mouseX - m_dragMouseX), MIN_W, screenW - panelX - 8)
    local height = Clamp(m_dragHeight + (mouseY - m_dragMouseY), MIN_H, screenH - panelY - 8)
    ApplyChrome(width, height)
    m_expandedHeight = height
    LuaEvents.Tutorial_DisableMapDrag(true)
end

function OnPanelInput(input)
    local message = input:GetMessageType()
    if message == MouseEvents.LButtonUp or message == MouseEvents.PointerUp then
        m_titleDragging = false
        m_resizeDragging = false
        LuaEvents.Tutorial_DisableMapDrag(false)
    end
    return false
end

function AttachLaunchButton()
    if m_launchAttached then
        return
    end
    local buttonStack = ContextPtr:LookUpControl("/InGame/LaunchBar/ButtonStack")
    if buttonStack == nil then
        return
    end
    local button = {}
    local pin = {}
    ContextPtr:BuildInstanceForControl("LaunchBarItem", button, buttonStack)
    ContextPtr:BuildInstanceForControl("LaunchBarPin", pin, buttonStack)
    pcall(function()
        buttonStack:AddChildAtIndex(button.LaunchItemButton, 3)
        buttonStack:AddChildAtIndex(pin.Pin, 4)
    end)
    button.LaunchItemButton:RegisterCallback(Mouse.eLClick, OnLaunchClicked)
    button.LaunchItemButton:SetToolTipString("TRIX 陪玩")
    buttonStack:CalculateSize()
    local backing = ContextPtr:LookUpControl("/InGame/LaunchBar/LaunchBacking")
    if backing ~= nil then
        backing:SetSizeX(buttonStack:GetSizeX() + 116)
    end
    local backingTile = ContextPtr:LookUpControl("/InGame/LaunchBar/LaunchBackingTile")
    if backingTile ~= nil then
        backingTile:SetSizeX(math.max(20, buttonStack:GetSizeX() - 20))
    end
    pcall(function()
        LuaEvents.LaunchBar_Resize(buttonStack:GetSizeX())
    end)
    m_launchAttached = true
    print("TRIX Companion launch button attached")
end

function OnViewReady()
    ShowPanel()
    AttachLaunchButton()
end

function Initialize()
    EnsureBus()
    Controls.SendButton:RegisterCallback(Mouse.eLClick, OnSendClicked)
    Controls.AnalyzeButton:RegisterCallback(Mouse.eLClick, OnAnalyzeClicked)
    Controls.ApproveButton:RegisterCallback(Mouse.eLClick, OnApproveClicked)
    Controls.RejectButton:RegisterCallback(Mouse.eLClick, OnRejectClicked)
    Controls.PauseButton:RegisterCallback(Mouse.eLClick, OnPauseClicked)
    Controls.FoldButton:RegisterCallback(Mouse.eLClick, OnFoldClicked)
    Controls.CloseButton:RegisterCallback(Mouse.eLClick, OnCloseClicked)
    Controls.TitleDrag:RegisterCallback(Drag.eDrag, OnTitleDrag)
    Controls.ResizeDrag:RegisterCallback(Drag.eDrag, OnResizeDrag)
    ContextPtr:SetInputHandler(OnPanelInput, true)
    Controls.PollAnim:RegisterEndCallback(OnPollEnd)
    BindAction("UnitMoved", "单位移动")
    BindAction("CityProductionChanged", "城市生产")
    BindAction("CityProductionCompleted", "城市生产完成")
    BindAction("ResearchChanged", "研究变更")
    BindAction("ResearchCompleted", "研究完成")
    BindAction("CivicChanged", "市政变更")
    BindAction("CivicCompleted", "市政完成")
    BindAction("LocalPlayerTurnBegin", "回合开始")
    BindAction("LocalPlayerTurnEnd", "回合结束")
    BindAction("CityAddedToMap", "建立城市")
    BindAction("UnitAddedToMap", "单位出现")
    BindAction("UnitRemovedFromMap", "单位消失")
    BindAction("ImprovementAddedToMap", "改良完成")
    BindAction("DistrictAddedToMap", "区域完成")
    BindAction("TradeRouteActivityChanged", "贸易路线")
    BindAction("DiplomacyDeclareWar", "宣战")
    BindAction("DiplomacyMakePeace", "议和")
    BindAction("GovernmentChanged", "政体变更")
    BindAction("PolicyChanged", "政策变更")
    BindAction("UnitPromoted", "单位升级")
    BindAction("GoodyHutReward", "部落村庄")
    ArmPoll()
    PullOutbox()
    Events.LoadGameViewStateDone.Add(ShowPanel)
end

Initialize()
