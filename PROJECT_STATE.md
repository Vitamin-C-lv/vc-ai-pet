# VC AI Pet — Project State

## 2026-10-02 — 简短图库追问先经过上下文工具决策

raw turn39b176b1-e4da-4612-8132-8f2b0253ad44：前文“花花你知道黑莓
的品种吗”，本轮“你去图库里面看看呗”，16ms后返回固定澄清，无
模型调用。旧needsVisualRecallTaskPlan仅覆盖多图总结，短图库请求
先进入Recent Visual/无内容描述捷径，不读取前文主体就结束。
现在图库/相册文字入口先经过已有reply模型决策，跳过两个近期图
加载捷径；模型仍可选择null，不把提及图库强制变成找图。普通当前
上传/明确近期图引用及纠错保持既有路径。模型决策若省略本轮主体、
却提及最近主人原话中的已确认名字，执行器仅据主人前文恢复目标，
不执行模型编造的品种/场景筛选条件；同一owner-grounded query
传到逐张核验和最后汇总。提示说明无需指定某张图就能查主体外观，
精确品种无法由照片确认时应给有限结论，不能因此跳过查看。
现有本地模型low256只读隔离调用：短追问选择describe_subject并
解析黑莓，约5.1秒；图库实现问题返回null，约4.6秒。实际规划里
曾夹带“伯恩山犬”，该建议不被执行器当作主人目标事实。定向runtime
回归覆盖真实前文、短追问、模型错误品种丢弃、功能问题不查图，及
转去早餐不混入黑莓；既有多图路由、代词目标与工具Brain测试通过。
无生产测试聊天写入，无新模型或APK变更。

## 2026-10-02 — low 推理预算提升至256

主人反馈128 token推理空间过小，明确指定low改256。共享Local Brain
REASONING_BUDGETS与runtime JSON同步设为256，其余off=0、medium=1024、
high=8192、max=16384保持。只重载17862 relay，未重启或安装模型。
普通App结构化聊天总输出768→896，单张find_photo核验896→1024，
反思628→756，维持先前最终回答空间；subject核验2048保持，快速
实体语音off与768保持。多图medium与其输出额度保持。
共享推理映射9项及上下文预留18项定向测试通过。现有模型隔离调用
low工具决策使用max_tokens=896，正确将“他”理解为黑莓并计划多图
总结，finish_reason=stop，completion_tokens=413，结构化输出正常；
无生产聊天写入。256仍是上限，不能据单次测试保证所有复杂问题
的推理都能自然结束，需继续人工观察质量与延迟。
共享服务仓库已有其他未提交工作，本次仅局部调整预算及对应断言，
不将其混入Pet提交。

## 2026-10-02 — 多图总结的代词目标保持

raw turn b2398d22-7b4f-48e0-920e-53d121402b8d 的主人前文明确
“我说的猫猫就是黑莓”，本轮“那你去图库里面看看总结一下他呗”却
返回三张卡通图。执行器为避免模型编造筛选条件，将 tool query 改为
本轮原话，但遗漏解析代词所需的主人前文；后续核验和汇总均继承这个
无主体的 query。现对包含代词且本轮未给出已确认名字的工具请求，
将最近三条主人原话附入检索目标；不把助手猜测或模型编造场景作为
检索事实。原始 userText 不变，同一 recallQuery 贯穿索引、逐张核验
及最后汇总，既有主人命名筛选可再次约束黑莓照片。
核验提示补充：不能把“总结他”降为任意图库图片总结；无法确定指代
则 uncertain 不发图。照片不能证实实际体重、健康或精确品种。
使用现有模型和生产低清缩略图只读隔离测试，海绵宝宝图 mismatch、
主人标注的黑莓猫图 match；medium 汇总明确总结黑莓并说明只有一张
不能对比，无生产聊天写入。调用链定向回归覆盖该真实前文和代词。

上一轮同步修复6e73c76已加载正式Host，state与旧turn的档案补收均
通过；Local Brain及Chinese-CLIP进程保持运行。ADB读取最新存储日志
确认旧发送状态已删除、无挂起消息；随后设备断开，手机重新加载
未完成。本轮不需要原生APK变更，也未清理App数据。

## 2026-10-02 — 聊天同步恢复、系统状态与图库工具意图

只读核对主人截图对应 raw turn 01f126e1-06cf-472c-81fb-2cd877525e76：
北京时间12:52:30收到“黑莓好像饿了”，约10秒后两条最终回复已入档。
前端历史回放对 recalled turn 限制一条 final，等待语也是 final，导致
后两条答案及思考时长被隐藏。移除历史按气泡数量截断，按档案完整呈现；
模型输出阶段已有的回复长度／数量约束保留。

网络发送回执未知与已接收轮询暂停现在均可自动恢复，同 submissionId
确认、同 turnId/cursor 补收，不另建消息；页面恢复可见或服务重新可达
会重试。已提交 pending 不再十分钟后清空，重连期间的下一条输入草稿
保留。网络请求15秒超时释放等待，主动消息轮询的 cursor 变化也用于
普通聊天补收，避免切换连接地址或重新载入后停在半轮历史。
网络确认、断线和失败状态采用独立“系统 · 消息同步”卡片，不作为
花花气泡或模型输出，不写入原始聊天档案。

原有服务端 submission Map 仅在进程内存在且十分钟过期，无法保证
跨 Host 重启的去重；现改为 ConversationStore SQLite 持久回执，
同 ID 按原文与 attachmentId 直接比较，无 TTL。同步保存回执后才
返回202，重启后的重复提交返回原 turnId，不另启模型／主人消息。
内存轮询任务丢失时从原始档案恢复已完成回复，使用 historyRecovered
重绘 canonical history；未完成任务明确返回 TURN_INTERRUPTED，
由系统状态提示处理，不冒充模型回复或自动重发。

本条旧图误调用是普通 reply 的 structured visualRecall 选择错误；
照片确为黑莓不足以说明饥饿状态，也不构成发图需求。收紧模型工具
决策指令：只有本轮回答需要历史照片证据／外观或明确找图、总结、
纠正回忆时选择图库；提及主体的当前状态或日常聊天返回 null。
仍由现有本地模型决定工具调用，不新增关键词拦截／模型安装。
照片核验再检查原始需求是否需要该图，主体一致不能代替发图相关性；
旧照片无法证明当前状态时 uncertain 且不返回回复草稿或图片。
现有模型隔离实测：“黑莓好像饿了”选择 null，问主体长相选择
describe_subject，明确找纸箱旧照选择 find_photo；只读生产低清猫图
对饥饿句单次核验返回 uncertain／replyMessages=[]，约2.8秒。
这些是定向正负例，不作为全图库准确率或所有话题都正确的保证。

前端定向回归覆盖未知回执重确认、轮询恢复、旧 pending 保留、完整
final 回放、独立系统提示、普通聊天 cursor 补收及挂起请求释放。
真实 Chrome 隔离 mock 复现 start 回执丢失与4次 poll失败，自动恢复
后只显示一条主人消息和一条回复，保留下一条草稿；无生产聊天写入。
Chrome 追加20分钟前的 accepted pending 重载，按档案补回找图等待语、
两条 final 及9.9秒时长，无新 start。真实临时 SQLite／LAN server
重建测试覆盖持久回执、409冲突、终态补收、明确中断及去重跨TTL；
既有 LAN 与 idempotency 定向回归通过。

ADB 只读确认现有 vivo 包含通知服务、通知权限已允许，版本正确。
本轮修复为服务端及远程页面，覆盖更新后重新载入页面即可生效；
保留 pet_host、设备通知开关及聊天数据，不卸载或清理App数据。


## 2026-10-02 — 花花主动消息与安卓后台提醒

新增 PetRuntime 主动消息调度：每分钟检查一次，主人两小时未互动后才考虑
主动问候；最近三小时内已发过、正在聊天／Dream／Reflection、花花睡着、
安静时段或达到每日上限时跳过。默认每天最多三条、北京时间22:00–08:00
不主动打扰，主页右上角设置可修改上限与安静时段或关闭主动发消息。
使用现有本地模型、medium 推理档位（1024 token预算）生成一两句消息，
每次由模型结合状态、最近聊天和最近五条主动消息自行拟定话题或问候，
不使用固定问题列表；模型可选择不发送；
生成期间主人开始互动则取消发送，不新增模型、不创建虚假的主人消息。

主动消息作为 assistant/proactive 保存进现有 ConversationStore 原始档案；
新增 private LAN settings/messages/test API，持久 sequence cursor 支持补收与
分页重放，long-poll 最长25秒并在断开时清理等待。测试按钮只在主人主动
点击时试发固定消息，测试消息不占自动发送的每日额度或冷却时间。
主动消息不写入 Memory、Dream 或 Reflection。
主人紧接着回复时会把这条主动邀请传给本地模型，后续普通聊天不会重复
插入。前端新增未读角标与轻提示，打开聊天后清除未读，后台接收与当前
页面阅读状态分开；自动历史刷新保留滚动位置，不覆盖正在发送的消息。

隔离 sandbox / fake brain 定向测试覆盖限频、跨日、关闭、重启保留设置与
cursor、主人到达取消、shutdown取消、长轮询唤醒／取消、LAN API、邀请
上下文。实测现有本地模型可以选择暂不打扰，也可生成主动问候；一次
实测出现未经依据的“天气不错”，提示收紧后返回不依赖实时外部信息的
问候。追加 medium 实测两次约10.4秒：邀请聊天，以及根据近期早餐话题
接着聊笑脸吐司，避开上一条陪玩的问法。所有模型测试不写正式聊天。
Chrome mock 验证设置、设备开关、未读提示、点击进入聊天及单条气泡，
异步通知权限和历史刷新期间的草稿／焦点／乐观发送气泡回归通过。

安卓新增用户启用的前台消息接收服务，使用现有连接配置，LAN 请求走
Wi-Fi，远程／Tailscale 请求走默认网络。首启设置历史基线，后续持久
cursor 支持断线补收；系统通知成功后才推进游标。通知使用独立 tag，
避免与常驻服务通知冲突；聊天页实际可见时不弹系统提醒，阅读状态仅
保存在当前进程，不把旧的页面状态带到进程重建后。安静时段补收的消息
仍显示通知但不响铃；点击通知打开聊天。

Android cursor／网络路由定向测试和最终 assembleDebug 通过。交付包：
D:/VC-AI-Pet/dist/LiHuahua-Android-2026-10-02-debug.apk。
部署限定更新 Pet 源码并重启主3080 Host，不重启共享 Local Brain 或
Chinese-CLIP，不连接ADB。需要主人在 App 主页右上角设置启用设备通知
并允许系统权限；真实手机通知、锁屏及 Tailscale 验收仍待主人完成。
无云推送时，Android Doze／厂商省电可延迟网络，不能承诺锁屏实时到达。

## 2026-10-02 — 旧图先核验后展示、检索纠正保留目标

只读定位主人截图对应聊天：在「记得之前给你装的身体吗」之后，
「就是那个方脑袋的机器人」46毫秒后出现客厅 media_ref，而视觉观察
约7.5秒后才完成。问题路径是 Recent Visual 的 previous 候选，不是
Chinese-CLIP 语义检索：裸「就是那个」进入身份指代，未解析到具体图片
后仍落入最近候选；VisualWorkingSession 只对 recalled 类型进行核验。
「不是客厅那张图，是方脑袋机器人」随后又通过文字重叠选择客厅，
非核验模式允许模型继续 inspect 别的候选，最终回答黑莓并发出猫图。

裸描述要求图片锚点或明确命名后才绑定身份；未解析的身份引用不再默认
选择第一候选。所有纯旧图会话（包括 previous）均走 verifyRecall，
只有 match 才发布 visual_image／media_ref；明确图片指代的候选池固定
到该图，核验失败不能随意转到另一张。上传／比较的既有协议不变。

明确找错图的反馈优先进入纠正检索，将「不是客厅……，是方脑袋机器人」
中的正向目标交给现有语义索引，不把否定的客厅当检索条件，不写为照片
命名。保存最近召回目标及主人否定的展示附件；被否定附件在语义排序
之前排除，同时 Host 过滤候选。纠正时最多检查5张排名候选，仍逐张
核对同一目标，不采用模型自由 nextVisualId；成功后保留目标供再次
纠正，简单「不是这张」可沿用目标，不因首个成功就清除上下文。

真实本地模型用截图中两张原图分别做 find_photo 核验：客厅与窗边黑莓
均返回 mismatch，replyMessages 为空；两次分别11.183秒／4.259秒。
测试只读生产素材，无生产聊天／数据库写入；结果在
/tmp/pet-multi-photo-recall-eval/robot-negative-check.json，脚本复用
D:/VC-AI-Pet/temp/chat-elegance-preview，不安装新模型，不连接ADB。
真实机器人照片的正向召回仍由主人验收，不将两项负例当作全图库准确率。

既有核验后发图、Recent Visual、Turn Orchestrator、上下文追问、多图
路由、主人命名／说明归档和语义索引定向回归通过。新增连续纠正回归
覆盖错误客厅／猫候选、目标复用、被否定附件排除与延迟核验期间不发图。
本轮后端变更部署后限定重启3080 Host，无需重新安装APK。

## 2026-10-01 — 主人指定推理预算与各调用档位

按主人指定将共享 Local Brain 的 off／low／medium／high 预算设为
0／128／1024／8192 token，max 仍为16384。服务预算默认值与 runtime JSON
同步修改，避免请求映射与上下文预留使用不同数字。

App 普通文字聊天和图库工具决策均使用 low；移除 allowVisualRecall 导致
所有文字请求强制 off 的分支。单张图库核验使用 low，多图总结逐张核验
与最终文本汇总均使用 medium；普通视觉检查仍为 medium，梦境仍为 high。
后台反思改为 low，只有 StackChan 实体机器人的普通快速语音路径为 off，
含图片／显式记忆／记忆追问的机器人请求仍不走快速语音路径。

总输出额度同时留出推理与结构化回答空间：找图核验896、主体外观核验
保持2048、多图逐张核验2048、多图汇总1792、反思628 token。推理调试显示本次实际选择的
档位，与请求一致。图库确认后发图、主人原话、语义索引及调试隔离不变。

本轮只修改后端和共享模型服务预算，不需要新 APK，不连接 ADB。

共享服务预算映射9项、上下文预算18项测试通过。真实现有模型在隔离
沙箱完成 low 多图规划（4.713秒）、medium 纸箱原图核验（9.091秒，
match）与 medium 已核验观察汇总（11.557秒）；汇总包含窗台与纸箱
场景，无偏好／性格推断。只读复用既有测试素材，无生产聊天／数据库写入。
这三个耗时为分阶段测量，不是完整一轮的总时延。主人接受适当增加等待
换取质量，仍须通过人工验收比较实际回答，不将开启推理等同于质量保证。

推理档位、图库工具 Brain、多图任务路由与调试 Runtime 定向回归通过。
共享预算经17862 relay限定重启加载；Pet代码部署后限定重启3080 Host。
共享模型服务仓库原有其他未提交工作保留，本次不将其混入 Pet提交。

## 2026-10-01 — 多照片需求规划、逐图核验与综合总结

只读核对生产聊天：主人两次要求「你要去图库多看几张黑莓的照片总结一下哦」，
两轮均仅检查一张不同原图。原句在首次请求里仍传给模型；确定的缺陷是
visualRecall schema 只有 find_photo／describe_subject，且 Host 在首个 match
时终止召回，语义候选还被截为两项。因此这次不能归因为整体上下文丢失。

新增 summarize_photos 目标及 photoCount：多看几张默认3，明确数量由本轮
现有回复调用规划，本轮最多核验5张候选。多图请求先经过任务规划，避免被
近期单图、显式搜索或「两张」的比较快捷路径提前截走；检索仍使用现有
Chinese-CLIP 语义索引，已确认主体命名约束在 top K 前生效，无图库逐图扫描。

执行器保留原始 userText 与自包含 recallQuery 两个字段。多图路径不因首个
match 结束，继续核验不同附件，达到计划数量或候选／5次预算用尽才总结。
只有原图明确 match 的公开可见观察进入最终汇总；mismatch／uncertain
候选不发图，不进入总结。所有匹配图在核验与总结成功后发布，草稿回复
不会提前成为最终气泡。数量不足由 Host 明确说明；没有匹配图不发图。

最终总结使用现有 Local Brain 的一次 text-only 调用，仅提供原始需求、
检索目标、每张已核验图的主人原话、已确认称呼与可见观察，综合共同特征
和场景差异。首次真实隔离测试暴露 text-only 汇总只有无名视觉观察时会
把「黑莓」误读为猫之外的对象；已将原图命名关联传递至汇总，不让它再次
猜测已核验身份。多图核验使用独立的简短提示，数量／共同特征属于整轮
任务，不能成为拒绝单张候选的条件。逐图核验与总结使用 off
推理，无新模型、无全局推理配置变更；普通单图 find_photo／describe_subject
保留首个 match 完成的快路径。可选开发调试将新增调用显示为「多图总结」。
原始主人说明、原图、Memory／Dream 和默认关闭的调试隔离保持既有约束。

新增定向测试入口 npm run test:visual-multi-photo。手机人工验收由主人完成，
不连接 ADB；本轮修改 Runtime／Brain，正式生效需要一次限定的3080 Host重启。

两项新增定向测试、既有单图验证后发图／工具 Runtime／上下文追问／主人
命名归档／语义索引／推理调试 Runtime 回归通过。真实现有模型的4条任务
规划通过：默认3张、明确2张、单张纸箱找图、算法元问题。修正身份上下文
后，在隔离沙箱复用两张真实黑莓原图及早餐干扰图，两个多图用例均只核验
和发布2张黑莓原图，窗台与纸箱共同进入总结；默认3张时明确说明不足。
两轮核验＋汇总分别9.031秒／8.038秒，不含前置规划；早餐未发出。

真实汇总还暴露了从照片推断「最喜欢」的多余感想。汇总收为恰好一条简短
回答，以实际张数／共同可见特征／场景差异为内容，temperature=0。
仅复用这次已核验观察再测文本汇总，1.037秒返回两场景与黑白毛色，无
偏好／性格推断。原始失败与修正结果留在 /tmp/pet-multi-photo-recall-eval，
脚本留在 D:/VC-AI-Pet/temp/chat-elegance-preview；均无生产聊天或数据库写入。

## 2026-10-01 — 主页设置位置与梦境入口排版修正

按主人截图反馈，将「设置」从主页底部移到 app-header 最右侧，使用
44×44 点击区域的齿轮按钮，连接状态点保留在旁边。设置面板及已有
开发调试开关的逻辑不变，标题栏随主页隐藏，不进入聊天／图库页面。

主页原有 flex-end 会在内容超高时把最上面的梦境入口推到可视区域
之外；明确改为 flex-start，从标题栏下方按内边距开始排列，短屏
沿已有主页内部滚动访问下方操作，根页面仍固定。仅修改静态 HTML／
CSS，无 Android shell 或 Runtime 变更。

隔离浏览器验证 393×852、360×800、320×568、393×500 通过：设置
44×44 按钮在标题栏右侧，梦境入口与标题栏保持间隔且完整可见；短屏
底部操作可访问，根 scrollY 为 0。设置系统返回关闭、梦境返回主页、
进入聊天隐藏主页标题栏通过；API 全部 mock，无生产请求。截图及脚本
复用 D:/VC-AI-Pet/temp/chat-elegance-preview。静态资源按请求 readFile
并使用 no-cache，部署此布局更新无需重启服务。

## 2026-10-01 — 聊天底部思考动画与可选模型推理调试

按主人本轮明确要求，移动端聊天在消息区与输入栏之间增加轻量思考状态：
小爪印和三颗跳动的点，从发送开始一直保留到整轮完成。图库检索、原图
核验、回复前的中间消息不会提前结束动画；失败与连接恢复沿既有发送
控制器收起／重新显示。动画不获取焦点，隐藏不占高，尊重减少动态效果。

主页增加低调的「设置」入口，「开发调试」默认折叠，「查看模型推理」
默认关闭。显式开启后，聊天中的耗时成为可点按钮，按该消息 turnId
展开本地模型实际返回的推理文本，多次模型调用逐项显示；再次点击收起。
展开后仅滚动消息区，把推理卡带入可视范围，不移动根页面。
关闭会收起详情并禁用耗时点击。设置保存在 Pet sandbox，重开 App／
重启服务后仍保留，已保存的最近 32 轮调试记录可以继续读取。

独立 ReasoningDebugStore 用 AsyncLocalStorage 关联整轮 text／visual
调用，只接收现有 Local Brain API 的 reasoning_content／reasoning 独立
字段，不解析最终正文来生成推理，不提高 effort，不增加模型调用。
默认关闭的轮次不创建调试上下文；普通后台 Dream／Reflection 不记录。
无推理字段的成功调用保留空文本与阶段 metadata，页面明确提示未返回；
开启前的旧轮次不能补回。实际多次视觉核验归属同一个 turn，不覆盖前项。

设置与记录单独保存于 sandbox/runtime/reasoning-debug.json，串行临时
文件＋rename 替换，不进入普通 conversation history／poll／turn events，
不进入 Memory／Dream／语义索引与前端诊断日志。原有 reasoning 仍仅为
耗时等白名单 metadata。关闭时专用读取接口返回 403；开启时无记录返回
unavailable。可选调试文件损坏恢复默认关闭，写入失败不会覆盖正常回复
或原始模型错误；设置保存失败保留原开关值。

一次隔离真实 Local Brain 测试（合成加法题、low、512 max_tokens）确认
实际 message 字段为 role/content/reasoning_content，返回 634 字符独立
推理，保存后重开读取一致，调用耗时 2.938 秒。测试仅写
/tmp/pet-chat-reasoning-debug-eval，不写生产聊天／Memory；未安装模型。
浏览器脚本复用 D:/VC-AI-Pet/temp/chat-elegance-preview，静态前端与
所有聊天／调试 API 使用隔离 fixture。手机端按主人要求由主人手工验收，
本轮不连接 ADB。此次修改为服务端 UI／Runtime，无 Android shell 变更。

新增 test:chat-developer-debug 覆盖指示器生命周期、默认关闭／持久化／
运行中读取／并行 turn 归属／写入失败、settings 与专用 trace API、
普通回复及同一视觉回忆轮的 reply＋visual-step 聚合，格式错误正文的
独立推理捕获，普通 history／poll 的隔离。上述定向测试通过。现有
耗时持久化、模型推理 profile、发送与刷新恢复、表情／键盘切换、导航、
视觉 turn orchestrator 与原图核验后发图回归通过。旧 profile 测试的
未 initialize runtime fixture 补齐既有 recallContext 依赖，生产路由不改。

隔离浏览器验收通过：393×852／320px 布局无横溢、减少动态效果停动画、
视觉中间回复与图片出现后 footer 仍显示、成功／失败收起且不抢焦点、
settings 的系统返回关面板并留在主页、默认关闭时不请求原文、纯文本
显示／空推理／旧轮无记录、关闭清理详情。实际点击自动将推理卡完整
带入消息视口，验收脚本无手动滚动，根 scrollY 仍为 0。三张 UI 截图
位于复用浏览器 staging，均为合成聊天 fixture，无生产 API 请求。

## 2026-10-01 — 当前照片身份纠正与主人命名关联修复

先只读核对主人截图相关的生产聊天：上传原话为「你看黑莓在晒太阳诶」，
后续回看仍使用同一张窗台原图，但模型回答把黑莓和猫咪拆成两个主体。
「不不不这个图上的猫猫就是黑莓」及「刚才那个阳台上的晒太阳的小猫就是
我们家的黑莓」两轮实际均耗时 1 ms，由 Recent Visual 指代失败直接触发
固定澄清，未调用模型。历史原话与原图保留，不重写旧回复。

RecentVisualResolver 现在对明确的照片身份陈述沿当前视觉对话中的实际
media_ref／sourceAttachmentId 关联，而不是只依赖紧邻的上传或文字词项。
最多跨过两次身份纠正及其固定澄清；普通话题打断此关联，多图比较没有
单一指代时仍澄清。可以纠正当前回看的较早照片，不会自动改最新上传。
纠正轮只核对已关联的这一张原图；疑问、猜测与假设不作为肯定身份陈述。

主人纠正以普通 user 消息保存原话，sourceAttachmentId 指向既有照片，
activityType 为 visual_owner_caption，attachment 仍为 null。增量视觉
归档将这类原始消息记为 owner_caption／raw 事件，eventId 使用原消息 id；
不新增上传或 occurrence，不覆盖最初 caption，不读取整库图片或请求模型。
语义编码源将原始上传说明和后续主人补充按时间合并，文本变化触发现有
embedding 增量重建。最新明确命名用于身份筛选，保留的旧名字不会再次
覆盖它；其他照片不受影响。助手猜测与 inferred observation 不能进入
主人说明。图库详情将这类记录标为「主人补充 · 主人原话」，Dream 观察
查询继续只取 observation／comparison，没有把命名升级成视觉推断。

普通视觉提示也明确传入当前图主人原话，称呼由肯定命名决定、外观与场景
由原图决定。针对本机实际出现的「黑莓在哪里」「这个是猫咪」以及补名字
时仍反问的行为加强了命名提示。回忆核验使用时间靠后的明确纠正，同时
仍要求主体类别、关键场景与原图吻合，只有 match 才发送照片。

新增 test:visual-owner-correction 包含指代／来源及归档两组测试，覆盖
截图两句、旧图回看、固定澄清后的补充、原始纠正持久化、无新附件、
助手猜测不入原话、名字纠正在 top-K 前筛选、普通话题与多图歧义、
增量同步幂等与语义 embedding stale 重建。现有最近视觉、turn orchestrator、
语义索引、回忆工具 runtime／brain、发图前核验、图库与 Dream 定向回归通过。

使用截图涉及的真实窗台原图、现有 Local Brain 和 GPU 编码器做隔离验收：
上传能直接称黑莓；两句截图纠正能回应黑莓、各只看一张原图，不再固定
追问。未命名照片补「小墨」的首次测试暴露疑问式确认，修复后实际回复
「是小墨」「小墨在窗边晒太阳呢」。另一组从旧主人 caption「小橘」纠正
为黑莓，经真实语义索引后查询黑莓能返回同一原图，旧名字小橘不再返回
该图；找晒太阳照片经原图 match 后发图 3.534 秒，回答外观 9.252 秒，
均仅一次核验。这些时间属于隔离模型测试，不是手机端完整网络延迟。
测试只写 /tmp/pet-owner-correction-eval，复用浏览器 staging 下的两份
临时验收脚本，没有写生产聊天、升级模型或连接 ADB。

部署仅更新 Pet 源码并使用现有 loopback restart 路由重新加载受管 Web host；
Local Brain 与 GPU 编码服务独立运行，Android APK 无需重新安装。真实
手机聊天验收仍由主人执行。

## 2026-10-01 — 全局字体分层与 emoji 选择后键盘误弹修复

根据主人要求，标题、聊天正文与系统提示采用三种协调的字体，并将实际字体
文件随 Pet 页面提供：标题使用寒蝉圆黑体 Medium，聊天气泡、输入框与图库
主人原话使用霞鹜文楷轻便版 Medium v1.522，其余界面与系统提示使用
Noto Sans SC 400。内部字体族名为 Huahua Title／Text／UI；保留上游 OFL
许可与来源说明，不向手机或 Windows 安装系统字体。文字颜色与奶油／蜜桃
配色沿用上一轮，emoji 保留设备彩色字形，诊断代码保留等宽字体。

标题与 UI 字体裁成固定页面文字、拉丁字母与标点；对话字体另外包含
GB2312 常用中文，缺字走系统字体回退。聊天正文 18 px／1.65，窄屏
17 px，输入框 17 px／1.35。三个 WOFF2 总计 1,804,648 bytes（约
1.72 MiB），按需加载，font-display: swap 使加载期间文字继续可见。
版本化文件名使用一年 immutable 缓存，CSS 仍重新验证。新增独立
typography.css 与 scripts/build-mobile-fonts.py；fontTools／Brotli
仅用于构建，不增加生产运行依赖。标题、首页、聊天、梦境、图库及诊断
统一使用这些角色，不改变图片与原始数据语义。

主人截图中的 emoji 面板被挤短，原因是选择表情后 insertEmoji 再次
focus 输入框，重新触发系统 IME。现在打开表情时 blur 输入框，点击表情
只插入并更新光标／草稿，不再次聚焦；面板保持打开。主人点输入框时关闭
表情并切回键盘，发送仍关闭表情并解除输入焦点。正常高度下表情区域显示
四排完整表情，剩余内容在面板内部滚动；视口缩小时仍受实际可见高度约束。

新增 test:emoji-keyboard-switch 覆盖打开／选择／切回输入框、光标替换、
maxlength 与 aria-expanded；现有 composer、导航、mobile-viewport
定向测试及 LAN UI 路由测试均通过。LAN 测试确认字体 200、font/woff2、
WOFF2 文件头及 immutable 缓存。真实 Chromium 检查通过 CDP 确认标题、
正文和提示使用已加载的三个自定义字体，未出现字体解码错误；连续插入
emoji 不聚焦、不改变面板高度，四排显示完整，点击发送仅提交一次并收起
面板／失去焦点。图库 320/393/430/768 px 布局、加载更多、完整原图、
原话、返回路径、空页和失败重试沿用隔离 fixture 验证，未写生产聊天。
聊天、表情、首页和图库截图已实际查看，浏览器脚本及截图复用
D:\VC-AI-Pet\temp\chat-elegance-preview，字体构建源留在其 font-build 子目录。

本轮不连接 ADB，不做真实 Android 输入法验收，主人自行检查。部署需要
重新加载 Pet 所在受管 DSH Web host，使新的 WOFF2 静态 MIME 生效；
Local Brain 与图库编码服务保持各自独立运行。重新打开 App 加载页面即可
取得新字体与表情修复，不需要重新打包或安装 APK。

## 2026-10-01 — 输入视口修复与温馨聊天／图库视觉

主人截图显示 IME 与 emoji 同时打开时，页面头部被移出画面，输入栏和
键盘之间出现大段空白。代码检查发现 visualViewport.scroll 被当作尺寸
变化处理，可误关键盘态；原实现只在键盘态更新高度，没有跟随 offsetTop。
页面根容器现在固定，持续跟随可见区域的高度和顶部偏移，键盘关闭动画中
不会提前恢复全屏高度。scroll 不再充当键盘收起信号，resize 不清输入焦点。
emoji 最大高度改为实际可见区域的 38%，消息与表情仍各自在内部滚动。
Android 系统返回仍先收 IME，页面返回沿实际进入路径处理。

整套颜色改为奶油底、近白卡片、蜜桃主人气泡、暖棕图标与发送按钮。
图库增加「照片里的小回忆」导览与独立刷新入口，列表和详情标题居中；
照片卡片留出清晰的日期、主人原话和复看信息。详情突出完整原图，原话、
视觉经历和线索分层展示；原图缺失时不显示空图片框。来源显示改为
「主人原话」「视觉推测」，原始文字与 RAW／INFERRED 数据语义保留。
图库样式独立在 gallery.css，不引入字体、素材下载或 UI 依赖。

根据主人追加要求统一中文字体回退：Apple 系统字体、苹方、Noto Sans SC、
微软雅黑 UI／微软雅黑及系统无衬线字体，使用设备已有字体。聊天正文
17 px／1.65（窄屏 16 px），标题 600 字重、正文 400；图库卡片说明
14 px、详情原话 16 px，日期和辅助文字 12 px，移除遗留 !important
字号冲突。照片卡片改为纵向 flex，避免短说明的卡片把照片向下居中。

新增 test:mobile-viewport 覆盖 focus pan、resize、scroll-only、发送 blur
到 IME 关闭之间的高度，以及保留输入焦点的 Android Back 收键盘情形。
新测试及现有 composer、导航、system-back、视觉消息和 dream-gallery
定向回归均通过。Chromium 使用独立 mock 对话及公开测试图片检查：
可视区域缩至 480 px 并偏移 120 px 后，顶部与输入栏落在正确边界；
根页面不能被 scrollTo／滚轮移动，消息和 emoji 内部仍可滚动，发送
只提交一次并收起 emoji／解除焦点。图库 320/393/430/768 px 无横向
溢出，标题居中；加载更多、原图、主人原话、详情→图库→聊天返回、
空图库、缺失原图及失败后刷新均通过。截图已实际查看，测试没有写生产聊天。
浏览器脚本及截图位于 D:\VC-AI-Pet\temp\chat-elegance-preview。

按主人要求，真实 Android 输入法与侧边手势效果交由主人进行人工验收。
此次修改均为服务端静态页面资源，部署后重新加载 App 即可生效，无需新 APK。

## 2026-10-01 — 聊天页 iOS 风格视觉打磨

聊天页局部使用暖白画布、白色花花气泡与浅杏色主人气泡，弱化边框和阴影。
角色名保留在 DOM 供辅助阅读，视觉上由左右对齐识别说话者；连续花花消息
间距缩小，回忆过程显示为低干扰提示。正文改为 16 px/1.6 行高，居中标题
与工具图标更精简；顶部/输入区细分隔与静态磨砂层保持清晰层次。

照片不再限高 160 px，最高 340 px、保持原比例，移除双重厚边框。
输入框圆角 22 px，发送改为 44×44 的圆形向上箭头；语音/表情/加图入口
保留，空草稿时发送仍移出布局。emoji 在窄屏改为六列，保证触摸宽度。
只给实时新增对话播放 180 ms 淡入上移，既有消息重绘不播放；系统减少动态效果
仍被遵守。IME、pointerdown 防丢点击、发送状态与实际返回路径保持原逻辑。
没有引入字体下载、UI 框架或新的本地模型。

现有输入框、导航与视觉消息定向回归通过。独立浏览器截图与交互验收使用
`D:\VC-AI-Pet\temp\chat-elegance-preview` 的示例对话和既有公开猫图片，
测试 API 的发送全部在浏览器 mock，不写生产聊天。
320/393/430/768 px 宽度的真实 Chromium 检查通过：无横向溢出，长文字与
连续英文链接换行，照片加载完整且不被容器裁切，工具与 emoji 点击区域
至少 44×44。发现并移除了回看照片外层遗留的 160 px 高度限制。
多行输入上限 132 px；点击发送只发起一次隔离 mock 请求，同时关闭 emoji
并失去输入焦点，最终回复正常展示。393×852 新旧/表情/空历史截图已查看。
本轮 ADB 未连接手机，Android 实机视觉验收未执行；页面资源通过现有静态
路由提供，重新加载 App 页面即可生效，无需打包新的 APK。

## 2026-10-01 — 安卓系统返回与界面动效

安卓侧边返回此前只查 WebView URL 历史，同 URL 内的聊天/图库导航不在
网页历史里，因此直接 finish Activity。现在先收起真实 IME，再关闭
连接设置或交给 Pet 页面返回处理；页面收起诊断/emoji 后退回上一层，
返回始终沿实际进入路径：图库详情 → 图库 → 进入图库前的页面（如聊天）
→ 首页。只有显式首页按钮清空导航栈。首页返回将任务放到后台，不关闭 Activity。
IME 已关闭但输入框仍聚焦时不会额外吞掉一次返回；草稿与选图不清空。
导航保存页面参数，返回照片详情时仍能恢复原先选择的照片。

页面前进/返回分别使用 210 ms 的小幅方向位移与淡入，快速切换取消上一段
过渡，导航立即生效。按钮按下/松开反馈统一到 140 ms，emoji、图片预览与
诊断面板入场 180 ms；隐藏立即生效，避免影响发送点击与键盘布局。
系统减少动态效果设置关闭这些动效。本轮为完成返回后的过渡动画，
尚未实现随侧边手指进度同步的 predictive-back 页面预览。

定向 JS 测试覆盖浮层、键盘、关闭键盘后的焦点、照片参数和页面栈；
现有导航与聊天输入回归通过。393×852 Chromium 真浏览器检查覆盖面板返回、
草稿保留、详情/图库/聊天/首页、快速连续返回与减少动态效果，无 JS 异常。
Android unit tests 36 项通过，最终 assembleDebug/lintDebug 通过，lint
0 errors、13 warnings。复用 `D:\VC-AI-Pet\temp\codex-android-visual-unify`
构建目录与缓存；最终 APK 已通过 ADB 覆盖安装，保留 App 数据。
实机侧边手势确认可以从图库退回聊天。主人明确要求“从哪儿来的到哪儿去”，
图库没有强制回首页规则；页面返回按钮与侧边返回共用导航栈，详情先退回图库。
最终 vivo V2359A 真机侧边 swipe 验收通过：聊天 → 图库 → 详情，连续返回
依次为图库 → 聊天 → 首页；emoji 单独收起，IME 一次收起后下一次返回首页，
首页侧边返回将任务放入后台，再次启动恢复首页。验收未发送新聊天消息。

## 2026-10-01 — 回忆停在等待语与长时延修复

只读查看生产聊天，截图两轮纸箱请求只有等待语和文字 memory_recall，
没有最终回复；旧轮诊断已超过内存保留时间，不能据此认定某个具体错误码。
同批实际聊天中，外观请求在等待语前耗时约 166 秒，另一轮约 79 秒规划
加 109 秒视觉处理。当前隔离复现纸箱原话可以成功，但耗时 48.77 秒，
两次 medium 核验分别生成 2,159/1,180 tokens；第一张已匹配仍查第二张。

照片检索现在首张明确 match 即返回，mismatch/uncertain 才检查下一张。
具体照片核验关闭推理，输出上限 768；主体外观保留 low 和 2,048 上限，
避免关闭推理时对原始标签出现过度拒绝。允许选择回忆工具的结构化聊天
关闭隐藏推理，普通带图视觉/比较仍维持 medium。专用核验提示移除比较目录
与观察账本，保留主人命名、原图类别与全部场景核验；单次核验超时 30 秒。
语义回忆不再展示另行检索的文字记忆卡。失败会保存明确结束答复、不发图，
保留 turn_failed 诊断，不会把错误标成成功；下一轮可重试。

无新附件的回忆不会创建“主人这次给花花看了照片”的 confirmed 记忆。
原始生产记录保留。外观查询的身份限定移到语义 top-K 之前，防止无名相似
照片占满五个候选；同一张原图的原始命名仍是身份依据。聊天总时长包含
工具决策之前的等待，失败/无匹配时也报告实际推理级别。

真实本地模型隔离验收：截图原话返回正确纸箱原图，48.77 秒降到 3.61 秒，
仅一次核验、95 completion tokens；不存在的宇航服/月球场景 7.02 秒结束
且不发图；黑莓外观经规划及 low 核验约 12.68 秒返回主人原始标注的照片；
公开测试“小墨”仅返回标为小墨的猫，没有错发小橘。定向测试覆盖先错后对、
首次匹配即停止、错名/无名不放行、单次超时、失败历史持久化、无伪上传记忆、
命名在 top-K 前筛选，以及现有新图/比较/显式记忆/派生证据行为。
测试聊天仅写隔离 `/tmp/pet-recall-speed-eval` 和公开测试 sandbox。

## 2026-09-30 — GPU 图像语义索引与有核验的回忆工具

经主人同意，使用 Chinese-CLIP ViT-B/16 的中文图文向量替代生产图库的
关键词候选排序和整库 VLM 缩略图扫描。模型固定到官方 revision
`36e679e65c2a2fead755ae21162091293ad37834`；单份权重约 718 MiB，
CUDA Python 环境约 6.54 GiB。Pet 独立编码服务仅监听 loopback `17863`，
使用现有 RTX 4070、CUDA FP16；共享 Qwen Local Brain 未更换模型。

现有视觉 DB 新增可重建的 512 维向量表：首次对图片缩略图和主人原始说明
编码，后台增量处理变化。检索只读取向量与元数据，不读取整库图片；
500 条合成向量的检索测试约 9–10 ms。真实 38 张图库建立 GPU 索引约
1.85 秒。热 GPU 单次文字/图片/混合编码中位数分别为 7.7/12.6/20.2 ms，
不代表包含 Qwen 规划和原图核验的完整聊天延迟。热编码器 PyTorch 分配
约 382 MiB、预留约 402–422 MiB；整卡使用增加约 0.8–0.9 GiB，包含
CUDA 上下文及其他活动，不能把分配值当作总显存占用。

正常聊天的一次结构化模型回复可选择 `search_visual_memory`，分为找具体
照片或回答主体外观。运行时使用主人原话作为检索条件，先显示等待语，
向量取最多五个候选，然后核验最多两张原图。只有明确 match 的照片才
进入聊天和历史；外观问题可使用首张确认的主体照片。普通聊天与检索技术
问题不调用照片工具。仅提供这一个 Pet 回忆工具，不扩展电脑操作能力。
原始命名事实先按 confirmed 筛选再取前两条，防止大量视觉推断挤掉命名；
按名字问外观时，没有原始照片标签建立身份的候选不放行。

公开图片独立测试图库包含纸箱里的猫、椅子上的猫、纸箱里的狗一家、
黑莓果实和早餐，共五张约 220 KB 图片，来源/许可证记录在
`/tmp/pet-public-semantic-fixtures/manifest.json`。首次八题实际本地调用
通过七题，暴露“小墨”请求被模型改为另一只猫的毛色，并把主人标为
“小橘”的照片错误命名为“小墨”。修复同时约束检索条件和原始命名关联；
回归测试确保高分错名照片无法进入 VLM，更不能发图，较低排名的正确命名
照片可正常核验，身份不明则不发。测试使用临时图库，没有写入生产聊天。
修复后真实模型四题定向复测全部完成并通过：“小墨长什么样子”返回
主人标为小墨的纸箱猫；带叶枝条上的黑莓果实返回果实；狗一家在椅子上、
猫穿红宇航服在月球上均不发图。命名题仍观察到模型规划阶段编造毛色，
运行时使用主人原话和原始命名约束阻止它影响检索或错认另一只猫。
同一照片多次上传时，将原始说明按时间合并并去重，最多 1,200 字，
保留首次命名；最新附件仍用作展示，不混入模型推断。
私人图库“笑脸吐司和海苔饭卷”修复候选首位排序后实际端到端通过，
正确返回最新原始附件，整轮 13.46 秒。完整手机体验仍需主人验收。

编码服务启动、依赖、GPU/CPU 回退与派生索引命令见
`docs/visual-embedding-server.md`。新增测试入口 `test:visual-semantic`。

正式部署已完成：代码 `27676d0` 已推送并快进到生产目录。独立编码单元
`vc-ai-pet-visual-encoder.service` 为 enabled/active，实际报告 cuda:0/float16。
派生索引命令写入 38 条、跳过 0 条，耗时 1,855 ms；只写视觉 DB 的
新增派生表。仅重启承载花花的 `vc-ai-pet-dsh-ensure.service`，手机状态
接口 `/api/pet/state` 成功响应，原有 Local Brain 健康检查正常。
没有更换 APK、写入测试业务聊天或将公开测试照片放入生产图库。
手机实际问答与网络切换不在这次主机验收中，留给主人人工确认。

## 2026-09-29 — 新上传图片误选上一张的修复

主人发送早餐图并说「你看看这个，这个是我们的早饭」，花花却展示上一张串串图。
生产会话归档的只读检查确认：该轮用户消息附有新图片，但首个
`visual_selected` 和 `visual_image` 都指向旧附件，当前图未被选择或检查。
原因是「看看」使带新附件的请求被判作 `historical_visual`，最近图片
resolver 又把旧图作为匹配项，编排器因此将旧图作为首图。

现在带新附件的普通看图轮仅把当前附件交给视觉会话；明确说「上一张／
前一张」或要求比较时仍可查看旧图。补全「这张和上一张」的比较识别。
回归测试以原话重现旧图可被选择的条件，断言视觉模型只收到当前图，实时
图片事件和历史 `media_ref` 也只指向当前附件；另验收了明确回看上一张和
双图比较。`v0.3-turn-orchestrator`、最近视觉回忆、视觉路由及完整视觉
记忆测试通过。诊断没有读取私人图片字节，也没有发起聊天或修改生产数据库。

## 2026-09-29 — 图库旧照先核对再发送

用户指出长期图库检索可能把错误的候选图直接发进聊天。根因是文本检索
`matched` 仅代表候选排序，旧流程却在 Local Brain 看原图之前就发出
`visual_image` 并持久化 `media_ref`，而且丢弃了其余长期候选。

长期视觉召回现从检索结果的原始附件构建最多 5 张候选图；Local Brain 对
每张原图按当前请求给出结构化 `match / mismatch / uncertain`。只有明确
`match` 才发出并保存 `visual_recall`、`visual_selected` 与 `visual_image`；
不匹配或看不清时检查下一张，全部无法确认时不发图并请主人补充特征。
核验过程不展示或保存隐藏思维链，也不把未确认候选的视觉观察写入经验库。
刚发图片和比较图片的路径保持原有行为。

合成候选测试覆盖高分错图后命中下一张、全不匹配、全不确定、模型失败、
最多 5 次检查，并同时断言实时图片事件和历史 `media_ref` 无错图。
`npm run test:visual-memory` 以及相关视觉路由/活动测试通过。对仓库示例
头像进行的真实本地视觉调用，错误描述返回 `mismatch`、吻合描述返回
`match` 且生成两条回复；没有任何聊天或数据库写入。
该结果只验证协议可用；黑莓纸箱的真实图库请求尚需在运行服务上验收。

## 2026-09-29 — 聊天发送触屏命中与键盘收起

用户反馈上次修复后，emoji 与系统键盘同时展开时点“发送”仍无效。真机
WebView 事件跟踪确认 `pointerdown`/`pointerup` 命中发送按钮，但按钮抢走
textarea 焦点后键盘收起、视口重排，最终 `click` 落到 `DIV`，发送回调未运行。
发送按钮现于 `pointerdown` 阻止默认抢焦点，待 `click` 到达后开始提交，
关闭 emoji 并让输入框失焦；异步结束不再自动重新聚焦。没有修改后端或 APK。

定向 composer 测试与两个脚本语法检查通过。真机冷启动加载新脚本后，
在 emoji 与系统键盘同时展开的状态，用 ADB 实际触屏点击发送按钮；
测试替身接住消息 `ui-check`（没有写入聊天历史），页面发送回调收到消息，
emoji 关闭、输入框失焦，Android `mInputShown=false`。生产真实请求未代用户发出。

## 2026-09-29 — 手机聊天发送与 emoji 面板修复

手机截图显示 emoji 面板和系统键盘同时展开，输入 `hi🤗` 后页面“发送”无响应。
线上 `chat-composer.js` 的显式按钮点击与 IME 表单确认共用 `composing` 拦截；
按钮仍显示可用，但 composition 尚未结束时点击被静默丢弃。发送路径也从未调用
emoji drawer 的关闭方法。已只改生产聊天 composer：手点发送可提交，IME
表单确认仍在 composition 期间受保护；开始提交时收起 emoji 面板。
`test/v0.4-mobile-composer-polish.mjs` 覆盖两条交互，测试与 `node --check`
通过。线上 `:17870/chat-composer.js` 已返回新脚本，手机冷启动后进入聊天页。
未代用户发送业务聊天；带真实输入与系统键盘的设备交互待用户确认。

## 2026-09-26 — StackChan 语音快答与延迟 A/B

仅 `source=stackchan-bridge` 且不含视觉、显式记忆请求或记忆跟进的机器人语音聊天启用 `voiceFastMode`，将本地 4B 请求的 reasoning effort 设为 `off` 并要求简短口语回复。手机聊天及其他来源不匹配该门控；视觉、记忆请求和记忆跟进保留原推理策略。策略单测和 StackChan 来源集成测试通过。

真实 `/api/pet/chat/start` 热态 A/B 使用同一句输入与同一 Qwen 4B/CosyVoice-300M/罗小黑参考音频。4B 调用从 `8.313 s` 降至 `3.629 s`，turn 完成观察从 `9.060 s` 降至 `3.807 s`；优化后回答长度从 15 增至 23 字符，CosyVoice 阶段变慢，最终请求至 24 kHz WAV 关闭时间从 `15.527 s` 增至 `16.283 s`。因此本轮只证实 LLM 阶段提速，尚未证实端到端提速。固定文本仅单次 A/B，不能作为稳定性结论。报告及 before/after WAV 在 `D:\CosyVoice-300M-NPU-Probe\luoxiaohei\latency-ab\`。

另用六条相同 prompt 做 `reasoning=off/low` 配对质量测试，共 12 次结构化响应，未观察到 off 在该小样本中有稳定的整体质量下降；两种模式偶尔都会漏掉一个次要条件。平均调用时间为 `2.724 s` 对 `9.447 s`。机器人回复提示已改为尽量一句、必要时两句，并覆盖明确要点；手机来源和视觉/记忆例外没有改动。该测试未将样例写入聊天历史。

## 2026-09-18 — 李花花实体 StackChan Phase 4 已部署

基于既有 Phase 3C handoff 的已确认事实，本轮完成实体身体的 app-only OTA1 部署和真实端到端验收。ota_0 @ 0x20000 Factory 恢复槽保留，未写入其应用区；ota_1 @ 0x510000 运行音量 90 固件。部署结果为 OTA0_APP_WRITES=0、OTA1_WRITE_VERIFIED=YES、OTA1_FIRST_BOOT_VALIDATED=YES。

PC Body Bridge 已连接 VC-AI-PET 17870 与 StackChan Wi-Fi，显示状态和表情同步通过；摄像头 JPEG 已进入现有 Qwen3.5-4B 原生多模态视觉路径并返回真实环境描述；实体扬声器已播放花花回复，音量 90 固件已重部署并收到 speaker ACK；麦克风 PCM → 本地 Vosk 中文 STT → 花花 4B → 本地 TTS → 实体扬声器闭环已实测。未使用收费 API，没有新增独立 0.8B 模型，也没有上传私人 Memory。

完整报告：docs/stackchan/PHASE4_FINAL_REPORT.md、docs/stackchan/PHASE4_ACCEPTANCE.md，以及本轮生成的 ZIP 报告包。

Status: FINAL_STATUS=READY_FOR_EXPERIENCE_AWARE_MEMORY_PIPELINE_REVIEW

## 2026-09-13 — 生产只读覆盖度审计 + 视觉轮显式记忆修复

用户提出：「说过的话有时候会忘，小思考是不是有问题？梦境频率好像还是很低，是不是有对话被漏掉了？」
用户自己的定性（已由只读审计证实）：**「没有从 raw archive 丢掉，但大量对话在进入 PetMemory 之前
被过滤掉了，因此对于小思考和梦境来说等价于"没经历过"。」**

只读审计生产 sandbox 的关键数据（`docs/AUDIT_MEMORY_COVERAGE.md`）：

```text
USER_DIALOGUE_TURNS        全量 157 / 48h 14
RAW_ARCHIVE_USER_TURNS     全量 157 / 48h 14        <- A 层没有丢
PET_MEMORY_ACCEPTED_RAW    全量  12 / 48h  1
MEMORY_ACCEPT_RATE         全量 7.6% / 48h 7.1%
REFLECTION_ELIGIBLE_RAW    全量  17 / 48h  1
REFLECTION_RUNS            全量  10 / 48h  1
DREAM_RUNS                 全量   4 / 48h  0
PET_MEMORY_RAW_IMPORTANCE_1 = 187 / 204             <- 进不了内生活的 source window
黑莓定点样本：raw 用户原话 12 条，对应 raw PetMemory 0 条
```

结论：**主因是上游 MemoryGate/视觉分支筛选过多，不是调度阈值保守**；
降低 Reflection/Dream 阈值只会更勤快地处理同一批被筛过的记忆。
另有一个独立问题：审计时 Dream checkpoint 后已有 4 条 pending 且超过 72h 年龄门槛
（eligibility=true），但 48h 内没有 Dream log —— 调度/状态侧需单独排查。

本轮修复（用户点名的 bug + 审计新发现的两个缺陷）：

```text
FIX_1（7d1a265）MemoryGate 弃用「拒绝原因白名单」：
  模型候选因 confidence-low / importance-low / level-denied 被拒时，显式请求一律走兜底。
  实测：用户描述的 remember=true+confidence=0.65 → written（priority=HIGH / source=USER_EXPLICIT）
FIX_2 视觉轮（vision-context）不再短路 gate：
  带图的显式记忆请求现在会落库；模型候选在视觉轮仍然禁止使用（raw/inferred 边界不变）。
  实测四组合：带图+显式→written；带图+无显式→skipped/vision-context；
  视觉模型候选→not-written；带图+敏感→skipped/memory-sensitive-reject
FIX_3 opt-out 正则不再把「不要记错/记混/记反」误判为退出指令（21 例矩阵 PASS）
FIX_4 短期窗口真正送达：prompt-builder 的 24 条硬截断改为参数化，
  contextTurns=50 → 实际送出 100 条消息，来源映射条目数同步
FIX_5 预算按真实 tokenizer 标定：shortTermContextChars 24000 → 18000
  （system 提示词本身 ≈11,975 token，典型 50 turns 11,753 token，24k 会溢出 16k context）
FIX_6 经验窗口 12 → 80 行：Reflection/Dream 能看到近期生活（含低 importance 的普通对话），
  但仍不可作为 source_ids
FIX_7 真值源统一：context-budget 的预算常量改为引用 pipeline config（曾分歧 18000 vs 24000）

NEW_TESTS=test/v0.4-context-window-delivery.mjs, test/v0.4-vision-explicit-memory.mjs
TEST_RESULT=ALL_PASS（新增 11 个测试 + 既有回归全 exit 0；npm run smoke 见下）
PRODUCTION_DB_MODIFIED=NO（审计全程 readOnly，无新文件、无 checkpoint）
PRODUCTION_DEPLOYED=NO  PRODUCTION_RESTARTED=NO  PUSHED=NO
```

待跟进（未修，需用户决策）：
1. Dream 调度/状态侧为何在有 eligible source 时 48h 未触发；
2. 关键词与正文脱节（模型给「一定要记住哦」塞了「黑莓」关键词，导致 generic 句子在
   `黑莓` 查询上排第一）——建议写入时校验 keywords 必须出现在正文/证据中；
3. `recall('猫')` 单字无命中（meow-memory 分词行为，非缺陷）。

## 2026-09-12 — Experience-aware Memory Pipeline（Memory Pipeline v2）

用户报告的故障：告诉花花「我们家的猫猫叫黑莓，你要记住」，之后花花「不知道猫叫什么」。

Phase 0 审计 + Root 现场探针（/tmp 临时 sandbox，生产 DB 全程未触碰）裁定：
**唯一主根因是显式记忆意图没有跨 turn 传播**——主人给一次指令后正常谈论那件事，
第二句（`我们家的猫叫黑莓`）没有关键词，旧 Gate 只能按普通消息处理，
模型 `model-skip` 时不写 PetMemory。次要因素：旧 Gate 白名单对
`importance-low/confidence-low/level-denied` 不兜底、旧 fallback 把
`我们家的…` 写成 `主人们家的…`、以及 `recall('猫')` 单字不入索引（非「没有记忆」的证据）。
真实 archive 无 candidate 字段，故「低分候选实际触发比例」标注为**无法验证**。

本轮交付（新 branch `feat/life-experience-buffer`，base 4a3b8ef）：

```text
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-life-experience
BRANCH=feat/life-experience-buffer
BASE_COMMIT=4a3b8ef（= 生产 Pet 当前 HEAD）
ARCHITECTURE_CHANGED=Conversation Archive -> Experience Buffer -> Consolidator -> Reflection -> PetMemory
PET_MEMORY_SCHEMA_CHANGED=NO
CONVERSATION_ARCHIVE_SCHEMA_CHANGED=NO
DREAM_GENERATION_LOGIC_CHANGED=NO
MEMORY_GATE_VALIDATION_WEAKENED=NO

NEW_DB=experience-buffer.sqlite (table experience_events + experience_buffer_meta)
NEW_FILES=src/experience/experience-buffer.js, src/experience/experience-consolidator.js,
          src/experience/experience-dream-context.js, src/memory/explicit-memory-queue.js,
          src/memory/explicit-memory-controller.js, src/memory/memory-pipeline-config.js,
          src/conversation/context-budget.js, scripts/migrate-experience-buffer.mjs
MIGRATION=npm run migrate:experience-buffer（默认 DRY-RUN，只读探查；--apply 才写；schema drift 拒绝）
MIGRATION_DRY_RUN_VERIFIED=YES
SHORT_TERM_CONTEXT_TURNS=48（配置化，token budget 动态上限，低优先级先裁剪，最近 6 轮永不裁剪）
EXPLICIT_MEMORY_METADATA=priority:HIGH source:USER_EXPLICIT
EXPERIENCE_BUFFER_RETENTION=14d

TEST_RESULT=ALL_PASS
  新增 8 个测试 exit=0（npm run test:experience-aware-memory）
  5 个用户点名验收用例全 PASS（CASE_1..CASE_5）
  既有回归全 exit=0：core / long-life / visual-memory 1.1+1.2 / mobile / conversation persistence
  npm run smoke exit=0
PRODUCTION_DEPLOYED=NO
PRODUCTION_RESTARTED=NO
PUSHED=NO
FINAL_STATUS=READY_FOR_USER_REVIEW
```

风险与未决事项见 `docs/DEVLOG_MEMORY_PIPELINE_V2.md` 第 8、9 节；
完整 Phase 0 审计见 `docs/AUDIT_MEMORY_PIPELINE_V2.md`。

## 2026-09-09 — Visual Canonical Deduplication on Current Production Lineage

基于当前正式 lineage `819fb2ce33013c86ae2ccfb56bdad2dfa8d6e60a` 建立
`feat/visual-canonical-dedup-current`，仅 transplant 已审查的
`c1a4b1ea7673de51de62d26a7ef53a91a99d26c9` Visual Canonical Dedup 变更。本轮不重写
dedup 算法，不修改 Tailscale、Android endpoint、submissionId、Composer、Dream toggle、LAN
或 Local Brain。UI 冲突保留当前 production navigation/composer/recovery/header 行为，再叠加
occurrenceCount、lastOccurredAt、visual-gallery-occurrences 与 Gallery detail occurrence
rendering；backend 仅落在 Visual Experience、Visual Gallery、Visual Dream Context、Visual
Recall、Visual Working Session 与 Pet runtime/orchestrator integration。

```text
BASE_COMMIT=819fb2ce33013c86ae2ccfb56bdad2dfa8d6e60a
SOURCE_DEDUP_COMMIT=c1a4b1ea7673de51de62d26a7ef53a91a99d26c9
BRANCH=feat/visual-canonical-dedup-current
LINEAGE_STATUS=AHEAD_BEHIND_CHECK_REQUIRED
ANDROID_COMPANION_MODIFIED_BY_DEDUP=NO
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DEPLOYED=NO
```

冲突处理只涉及 `PROJECT_STATE.md` 文档；代码冲突按 current production 版本保留并叠加
dedup additions。migration preview 继续只使用 sandbox/temp DB，保持
`MODEL_CALLS=0`、`PET_MEMORY_WRITES=0`、`DREAM_RUNS=0`。

## 2026-09-09 — Conservative Perceptual Dedup Gate After Real Production-Copy Review

基于 `38b60954d38e1cfa6f34779518b7139bb1cb2e0f` 收紧通用 visual fingerprint gate，禁止
针对 G05、attachment、owner text 或蜡笔小新做 special-case。默认阈值从 `4/4/0.02`
改为 `1/1/0.005`，仍保持 model-free、fail-closed 的 PERCEPTUAL matching。

真实 production-copy `41` roots 重新 preview：G05 candidate
`530979ae-e78f-43b6-9913-16ed3eb7cb88` 不再进入 duplicate group；G07 的
`pHash=0,dHash=1,aspect=0` near-duplicate 仍进入 group。新增 regression 覆盖
added-object gate `pHash=2,dHash=4,aspect≈0.0123` 的 NO-MERGE，以及高置信 near-duplicate
的 YES-MERGE。普通 resize fixture 在新 gate 下实测 `pHash=2,dHash=0,aspect=0`，因此保留
真实 FAIL 结果，不为让 fixture 通过而放宽阈值。

```text
SOURCE_COMMIT=38b60954d38e1cfa6f34779518b7139bb1cb2e0f
PREVIOUS_THRESHOLDS=4/4/0.02
NEW_THRESHOLDS=1/1/0.005
G05_FALSE_MERGE_REGRESSION=PASS
G05_GROUPED=NO
G07_HIGH_CONFIDENCE_DUPLICATE=PASS
G07_GROUPED=YES
RESIZED_DUPLICATE=FAIL
MODEL_CALLS=0
PET_MEMORY_WRITES=0
DREAM_RUNS=0
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DEPLOYED=NO
FINAL_STATUS=PERCEPTUAL_THRESHOLD_REVIEW_REQUIRED
```

## 2026-09-09 — Conservative Two-Gate Perceptual Matching

在不放宽 strict gate 的前提下，新增独立的 resize-safe gate：strict 为
`pHash<=1,dHash<=1,aspect<=0.005`，resize-safe 为
`pHash<=2,dHash<=1,aspect<=0.001`。匹配关系是 `strict OR resize-safe`。内部 reason
区分为 `PERCEPTUAL_STRICT` / `PERCEPTUAL_RESIZE_SAFE`，对外 occurrence 继续返回
`duplicateKind=PERCEPTUAL`，并提供 `perceptualGate=strict|resize-safe`，保持既有 API
contract。没有 G05、attachment、owner text 或动画 special-case。

dedup fixture 重新确认 exact、re-encode、metadata 与 ordinary resize 均通过；resize
实测 `pHash=2,dHash=0,aspect=0` 使用 `resize-safe` gate。G05 boundary
`2/4/~0.0126`、`2/2/0`、`2/1/>0.005` 与 `3/0/0` 均拒绝。新鲜 production-copy
包含 `41` roots：G05 不再分组，G07 的 `0/1/0` strict near-duplicate 保持分组。
唯一非 EXACT group 为 G07，contact sheet 人工复核未发现明显内容变化。

```text
BASE_COMMIT=819fb2ce33013c86ae2ccfb56bdad2dfa8d6e60a
SOURCE_COMMIT=096845609497daad1e93756d7f2825c85688b101
STRICT_GATE=1/1/0.005
RESIZE_SAFE_GATE=2/1/0.001
ROOTS_BEFORE=41
DUPLICATE_GROUPS=10
ROOTS_AFTER_CANONICAL_VIEW=26
EXACT_GROUPS=9
STRICT_PERCEPTUAL_GROUPS=1
RESIZE_SAFE_PERCEPTUAL_GROUPS=0
G05_GROUPED=NO
G07_GROUPED=YES
FALSE_MERGE_FOUND=NO
SECOND_APPLY_ALIASES_CREATED=0
SECOND_APPLY_OCCURRENCES_CREATED=0
SECOND_APPLY_NEW_ROOT=0
MODEL_CALLS=0
PET_MEMORY_WRITES=0
DREAM_RUNS=0
ANDROID_COMPANION_MODIFIED_BY_DEDUP=NO
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DEPLOYED=NO
FINAL_STATUS=READY_FOR_VISUAL_DEDUP_PRODUCTION_MIGRATION_REVIEW
```

## 2026-09-08 — Final Idempotency TTL Alignment Fix

基于用户指定的 `dcb6c6095ef5eeeef76549135d2f46be465a9db0` 在独立 worktree
`fix/chat-start-idempotency` 上只做本轮 TTL 对齐。既有提交身份仍位于页面
生命周期之外的 host-lifetime `/api/pet/chat/start` 边界：前端每次显式发送生成独立
`submissionId`，服务端 host-RAM registry 记录 `submissionId -> turnId` 与
`message + attachmentId` fingerprint；同 ID 同 payload 返回同一 turn 且不会再次
调用 `runtime.startChatTurn`，同 ID 不同 payload 返回 409
`SUBMISSION_ID_CONFLICT`。registry 为最多 256 条、10 分钟 TTL 的 LRU/TTL 内存
结构，不进入 ConversationStore、PetMemory 或 Visual DB；既有 PetTurnManager
TTL 为 15 分钟且本轮不修改，故 server idempotency TTL 与前端 pending max age
均不超过后端 turn 生命周期。Pet Host 重启后的全局 exactly-once 不作保证。

mobile submission state 现在把 pending submission 的非敏感元数据写入
`localStorage`：保存 transport metadata + pending user message text，即 schema、
submissionId、message、attachmentId、stage、turnId、after、createdAt 与 hasImage；
不保存图片 base64、tokens、CoT 或 secrets。
`PRE_UPLOAD` 的图片仍只在 RAM，reload 后清除并提示重新选择；`UPLOADED` 复用
attachmentId；`START_IN_FLIGHT`/`START_ACCEPTANCE_UNKNOWN` 用同 submissionId 做
start reconciliation；`TURN_ACCEPTED` 直接复用同 turnId/after poll。完成或
`TURN_FAILED` 清除 pending；过期 pending 清除且不自动 start。accepted poll 保留
1s/2s/4s 最多三次 bounded same-turn retry，耗尽后显式继续等待仍只 resume 同一
turn。确认的 legacy 404/405 只给未带 submissionId 的旧客户端使用，ambiguous
start 不走 legacy fallback。

`test/v0.5-chat-start-idempotency.mjs` 覆盖 N–Q、AA、Z 的真实 LAN HTTP registry、409
conflict、distinct submission、LRU/TTL 与双客户端竞态；
`test/v0.5-mobile-reload-recovery.mjs` 覆盖 R–Z、AB 的 localStorage reload/restart
fixture、附件复用、同 turn/cursor、PRE_UPLOAD 重新选择、完成/失败清理与 stale
清理。既有 A–M、composer autosize/Plus/Send/IME/Emoji、navigation、Dream/Gallery、
Visual、diagnostics、turn orchestrator 与 client bundle 校验继续通过。

FINAL_STATUS=READY_FOR_GITHUB_FINAL_REVIEW
BASE_COMMIT=dcb6c6095ef5eeeef76549135d2f46be465a9db0
BRANCH=fix/chat-start-idempotency
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-chat-start-idempotency
COMMIT=RECORDED_IN_GIT
REMOTE_HEAD=PUSHED_TO_ORIGIN
WORKTREE_STATUS=CLEAN_AFTER_COMMIT
SUBMISSION_ID_GENERATION=CRYPTO_RANDOM_UUID_WITH_SECURE_RANDOM_TIME_COUNTER_FALLBACK
SUBMISSION_ID_PERSISTED=LOCALSTORAGE_CONTENT_TRANSPORT_METADATA_PLUS_PENDING_USER_MESSAGE_TEXT
SUBMISSION_ID_REUSED_AFTER_RELOAD=YES
SERVER_IDEMPOTENCY_REGISTRY=HOST_RAM_SUBMISSION_ID_TO_TURN_ID_AND_FINGERPRINT
SERVER_IDEMPOTENCY_BOUNDED=MAX_ENTRIES_256_LRU
SERVER_IDEMPOTENCY_TTL=10_MINUTES
PET_TURN_MANAGER_TTL=15_MINUTES
PET_TURN_MANAGER_MODIFIED=NO
PENDING_SUBMISSION_MAX_AGE=10_MINUTES
IDEMPOTENCY_TTL=10_MINUTES
TTL_ALIGNMENT=PASS
STALE_TURN_REPLAY=NO
LOCALSTORAGE_CONTENT=transport metadata + pending user message text
LOCALSTORAGE_USER_MESSAGE_TEXT=YES
LOCALSTORAGE_IMAGE_BASE64=NO
NO_IMAGE_BASE64=YES
NO_TOKEN=YES
NO_COT=YES
NO_SECRET=YES
SAME_SUBMISSION_SAME_TURN=PASS
SAME_SUBMISSION_START_CALL_COUNT=1
SUBMISSION_PAYLOAD_CONFLICT=HTTP_409_SUBMISSION_ID_CONFLICT
DIFFERENT_SUBMISSION_SAME_PAYLOAD=DISTINCT_TURNS
START_IN_FLIGHT_RELOAD=IDEMPOTENT_RECONCILIATION
START_UNKNOWN_RELOAD=IDEMPOTENT_RECONCILIATION
TURN_ACCEPTED_RELOAD=SAME_TURN_AND_AFTER
UPLOADED_RELOAD=SAME_ATTACHMENT_ID_NO_UPLOAD
ATTACHMENT_REUPLOAD_AFTER_RELOAD=NO
PENDING_STORAGE_CLEARED_ON_COMPLETE=YES
PENDING_STORAGE_CLEARED_ON_FAIL=YES
STALE_PENDING_CLEARED=YES
LEGACY_FALLBACK_AMBIGUOUS_START_DUPLICATE=NO
CROSS_WEBVIEW_RELOAD_DUPLICATE_TURN=NO
CROSS_APP_RESTART_DUPLICATE_TURN=NO
CROSS_PET_HOST_RESTART_EXACTLY_ONCE=NOT_GUARANTEED
GLOBAL_EXACTLY_ONCE_CLAIMED=NO
CASE_A_TO_M=PASS
CASE_N_TO_Z=PASS
CASE_A_TO_Z=PASS
CASE_AA=PASS
CASE_AB=PASS
VISUAL_MEMORY_MODIFIED=NO
DREAM_MODIFIED=NO
PET_MEMORY_MODIFIED=NO
LOCAL_BRAIN_MODIFIED=NO
LAN_TOPOLOGY_MODIFIED=NO
ANDROID_NATIVE_MODIFIED=NO
PRODUCTION_DEPLOYED=NO

## 2026-09-08 — Composer Transport Ambiguity Final Fix

基于用户指定的 `cc8d743f5198e6e4359b1ca046cc80c198fe27b6` 继续在独立
worktree 修复 mobile composer transport recovery。本轮调查确认 `/api/pet/chat/start`
先完成 handler 校验，再调用 `runtime.startChatTurn`；`PetRuntime` 委托
`PetTurnManager.start`，而 `PetTurnManager` 会在异步 run 开始前先把 turn 放入内存
Map，随后 handler 才返回 202/turnId。因此 start 请求发出后的 response loss 不能
被推断为未创建 turn。现有 handler 没有可安全关联的 turn-list/reconciliation API，
本轮不猜测、不修改后端，而是让前端对未知 ownership fail closed。

submission state 现在明确区分 `PRE_UPLOAD`、`UPLOADED`、`PRE_START`、
`START_IN_FLIGHT`、`START_ACCEPTANCE_UNKNOWN`、`TURN_ACCEPTED`、
`TURN_COMPLETED` 与 `TURN_FAILED`。start 之前明确可证明的 validation/transport
unavailable/capacity rejection 才能安全回滚；generic 5xx、无 HTTP response、无效
start response 均保留 optimistic owner bubble，清空但不恢复为可发送 draft，保留
RAM 中的 uploaded attachment，禁止 automatic start/upload。accepted poll 的
transport error 只按 1s/2s/4s 最多三次 bounded same-turn retry，保存并复用同一
`turnId` 与 `after` cursor；耗尽后保持 paused，`继续等待` 仅调用同一 turn 的
explicit resume。`TURN_FAILED` 仍保留 owner bubble，不自动重复发送。

没有修改 ConversationStore semantics、Chat backend API、PetTurnManager、Visual
Memory、Dream、PetMemory、Local Brain、LAN topology 或 Android native，也没有
production deploy。

FINAL_STATUS=READY_FOR_GITHUB_REVIEW
BASE_COMMIT=cc8d743f5198e6e4359b1ca046cc80c198fe27b6
BRANCH=fix/composer-failure-recovery
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-composer-failure-recovery
COMMIT=RECORDED_IN_GIT
REMOTE_HEAD=PUSHED_TO_ORIGIN
WORKTREE_STATUS=CLEAN_AFTER_COMMIT
AMBIGUOUS_START_ACCEPTANCE_HANDLED=PASS
START_IN_FLIGHT_STATE=PASS
START_UNKNOWN_AUTO_RESEND=NO
START_UNKNOWN_DRAFT_RESTORED=NO
ACCEPTED_POLL_BOUNDED_RETRY=PASS
ACCEPTED_POLL_RETRY_START_COUNT=0
EXPLICIT_RESUME_SAME_TURN=PASS
ATTACHMENT_UPLOAD_COUNT_ON_FAILURE_RETRY=1
ATTACHMENT_REUSED=YES
AUTOMATIC_DUPLICATE_TURN=NO
SERVER_TURN_FAILED_DUPLICATE=NO
CASES_A_TO_H=PASS
CASES_I_TO_M=PASS
PRODUCTION_DEPLOYED=NO

`test/v0.4-mobile-submission-recovery.mjs` 现在覆盖 A–M：包含 response lost
unknown、unknown ordinary submit no new start、accepted bounded retry same turn/
cursor、eventual completion、retry exhaustion 与 explicit resume；既有
autosize、Plus/Send、IME、Emoji、文字/图片路径继续通过。完整 smoke 等价 Node
子命令、客户端构建、`lib/client.js` 语法检查和 bundle 校验均已通过；真实
Android/生产验收不属于本轮边界。

## 2026-09-08 — Composer Failure Recovery Correctness Fix

基于用户指定的 `3d53660ea923bc7ba0cdd795dc30182b4f1fabc4` 建立独立
worktree。本轮只调整 mobile frontend submission state/recovery：明确
`PRE_UPLOAD`、`UPLOADED`、`TURN_ACCEPTED`、`TURN_COMPLETED` 与终态
`TURN_FAILED`；pre-accept 失败回滚 optimistic user bubble 并恢复草稿/图片；
已上传的 attachment 在 start 前显式重试时复用；已接收 turn 的网络失败保留
同一 `turnId` 并在重新连接时继续 poll。没有修改 ConversationStore semantics、
Chat backend API、PetTurnManager、Visual Memory、Dream、PetMemory、Local Brain、
LAN 或 Android native，也没有 production deploy。

FINAL_STATUS=READY_FOR_GITHUB_REVIEW
BASE_COMMIT=3d53660ea923bc7ba0cdd795dc30182b4f1fabc4
BRANCH=fix/composer-failure-recovery
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-composer-failure-recovery
COMMIT=RECORDED_IN_GIT
REMOTE_HEAD=PUSHED_TO_ORIGIN
WORKTREE_STATUS=CLEAN_AFTER_COMMIT
PRE_ACCEPT_FAILURE_RECOVERY=PASS
OPTIMISTIC_BUBBLE_ROLLBACK=PASS
UPLOAD_RETRY_COUNT=1
ATTACHMENT_REUSED=YES
TURN_ACCEPTED_TRACKING=PASS
POLL_FAILURE_REUSES_TURN_ID=PASS
AUTOMATIC_DUPLICATE_TURN=NO
SERVER_TURN_FAILED_DUPLICATE=NO
TEXT_IMAGE_SUCCESS=PASS
AUTOSIZE_REGRESSION=PASS
PLUS_SEND_REGRESSION=PASS
IME_REGRESSION=PASS
EMOJI_REGRESSION=PASS
CHAT_BACKEND_MODIFIED=NO
PRODUCTION_DEPLOYED=NO

新增 `test/v0.4-mobile-submission-recovery.mjs` 覆盖 upload 前失败、已上传
start 前失败重试、accepted 后同 turn 恢复、server `TURN_FAILED`、optimistic
bubble 数量、图片上传次数与 attachment id 复用；既有
`test/v0.4-mobile-composer-polish.mjs` 的 autosize、Plus/Send、IME、Emoji
与文字/图片路径继续通过。客户端构建与 bundle 校验通过；真实 Android/生产
验收未运行。

## 2026-09-08 — Android UI Acceptance Small Fix: Composer + Chat Header

基于用户指定的 `5b968f6a86acb8d8211861871b4391f7562367c6` 建立独立
worktree。本次只调整移动端 Chat composer 的 Plus/Send 分离、textarea
autosize、emoji 插入辅助、现有图片选择器接线，以及 Chat sticky header/shell
的 CSS 特异性与布局；复用现有 upload、attachmentId、chat start/turn 和视觉
渲染链路。没有部署生产，也没有修改导航协议、Chat 后端、Visual Memory、Dream、
PetMemory、Local Brain、LAN 或 Android native shell。

FINAL_STATUS=READY_FOR_PRODUCTION_DEPLOYMENT
BASE_COMMIT=5b968f6a86acb8d8211861871b4391f7562367c6
BRANCH=feat/mobile-ui-composer-polish
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-mobile-ui-composer-polish
COMMIT=RECORDED_IN_GIT
REMOTE_HEAD=PUSHED_TO_ORIGIN
WORKTREE_STATUS=CLEAN_AFTER_COMMIT
TEXTAREA_AUTOGROW=PASS
TEXTAREA_AUTOSHRINK=PASS
TEXTAREA_RESET_AFTER_SEND=PASS
TEXTAREA_MAX_HEIGHT=132
PLUS_ALWAYS_VISIBLE=PASS
SEND_VISIBLE_EMPTY=PASS
SEND_VISIBLE_TEXT=PASS
SEND_VISIBLE_IMAGE=PASS
SEND_VISIBLE_TEXT_AND_IMAGE=PASS
TEXT_THEN_IMAGE=PASS
IMAGE_THEN_TEXT=PASS
TEXT_DRAFT_PRESERVED=PASS
ATTACHMENT_PRESERVED=PASS
SECOND_IMAGE_UPLOADER_CREATED=NO
CHAT_API_MODIFIED=NO
EMOJI_INSERT_AUTOSIZE=PASS
IME_GUARD=PASS
CHAT_HEADER_WHITE_FRAME_REMOVED=PASS
CHAT_HEADER_TITLE_CENTERED=PASS
CHAT_HEADER_STICKY=PASS
SAFE_AREA=PASS
NAVIGATION_REGRESSION=PASS
GALLERY_REGRESSION=PASS
DREAM_REGRESSION=PASS
VISUAL_PRESENTATION_REGRESSION=PASS
PET_MEMORY_MODIFIED=NO
VISUAL_DB_MODIFIED=NO
DREAM_LOGIC_MODIFIED=NO
LOCAL_BRAIN_MODIFIED=NO
LAN_MODIFIED=NO
PRODUCTION_DEPLOYED=NO
ANDROID_MANUAL_ACCEPTANCE=NOT_RUN

纯 VM/假 DOM 的 `test/v0.4-mobile-composer-polish.mjs` 覆盖 A–M 行为；现有
mobile navigation、Dream/Gallery、Visual Presentation Cleanup、Visual Memory
1.2、Visual Memory 及 smoke 等价 Node 命令全部通过。浏览器 computed-style
探针也确认 `#chat-view` padding 为 `0px`、Chat header 使用页面暖色背景且无
shadow/radius、三列为 `44px 1fr 44px`、标题居中、composer 为 flex、隐藏 Send
仍预留固定槽位。真实 Android 设备/键盘接受测试仍留在部署前手工边界。

## 2026-09-07 — Mobile UI / Navigation Redesign

基于 contextual visual recall follow-up 的只读基线建立独立 worktree。本次只改
移动端 UI、逻辑导航、composer 接线和静态图标服务；Home 宠物卡、聊天消息/
thinking/visual activity/media_ref、Dream/Gallery 内容语义与已有图片发送链路
保持不变。没有部署生产服务，也没有修改 Android、数据库或 PetMemory。

FINAL_STATUS=READY_FOR_PRODUCTION_DEPLOYMENT
BASE_COMMIT=fdc3dcb42b694b076f635516822e84eaaae648ef
BRANCH=feat/mobile-ui-navigation-redesign
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-mobile-ui-navigation-redesign
LUNA_MAX_AGENTS_USED=5
DEEPSEEK_PRO_USED=NO
HOME_CORE_LAYOUT_PRESERVED=PASS
DREAM_ENTRY_ON_HOME=PASS
HOME_GALLERY_ENTRY_REMOVED=PASS
HOUSE_CONSTRUCTION_PLACEHOLDER=PASS
CHAT_HEADER_HOME_GALLERY=PASS
CHAT_OLD_BOTTOM_NAV_REMOVED=PASS
COMPOSER_MIC_NO_PERMISSION=PASS
COMPOSER_EMOJI_DRAWER=PASS
COMPOSER_PROVIDER_HOOK=PASS
COMPOSER_ADD_SEND_STATE=PASS
COMPOSER_EXISTING_TEXT_IMAGE_PATH=PASS
CHINESE_IME_COMPOSITION_GUARD=PASS
NAVIGATION_LOGICAL_STACK=PASS
NAVIGATION_HOME_FALLBACK=PASS
GALLERY_CHAT_CHILD_FLOW=PASS
STATIC_SVG_ASSETS=PASS
UI_NAVIGATION_FIXTURE=PASS
SMOKE_SCRIPT_BODY=PASS
VERIFY_CLIENT_STEPS=PASS
VISUAL_MEMORY_1_2=PASS
VISUAL_MEMORY=PASS
LONG_LIFE_AND_INNER_LIFE=PASS
DIFF_CHECK=PASS
PET_MEMORY_MODIFIED=NO
VISUAL_DB_SCHEMA_MODIFIED=NO
DREAM_LOGIC_MODIFIED=NO
LOCAL_BRAIN_MODIFIED=NO
CHAT_API_OR_PAYLOAD_MODIFIED=NO
LAN_API_OR_TOPOLOGY_MODIFIED=NO
LAN_STATIC_SVG_MIME_SUPPORT=YES
ANDROID_NATIVE_MODIFIED=NO
ANDROID_MANUAL_ACCEPTANCE=NOT_RUN
PRODUCTION_DEPLOYED=NO

本机没有 npm 可执行文件；因此 npm run smoke、npm run verify:client、
npm run test:visual-memory-1.2、npm run test:visual-memory 的脚本体分别以同一组
node 子命令执行并全部通过。客户端构建输出为 lib/client.js 62747 bytes，未产生
额外工作树改动。真实 Android 键盘与设备验收留在部署前手工边界。

## 2026-09-07 — Contextual Historical Visual Recall Follow-up Fix

基于 `5b4ad5685e95a6e3b7d8a790b1dff6c857796515` 建立独立 worktree，修复
视觉回忆语境中的自然追问、澄清回答和 subject correction 路由。本次复用既有
RAM-only `VisualRecallContext`，只增加 turn/session-scoped frame 字段；无新的
永久记忆、Visual DB 控制记录或第二套 Visual Memory。

```text
BASE_COMMIT=5b4ad5685e95a6e3b7d8a790b1dff6c857796515
BRANCH=feat/contextual-visual-recall-followup
CURRENT_MESSAGE_ONLY_INTENT_BEFORE=NO
CURRENT_RECENT_INTENT_BEFORE=NONE
CURRENT_ROUTE_BEFORE=ORDINARY_CHAT
WHY_NOT_TRIGGERED=message-only detector rejected 想想+subject; clarification no-candidate path cleared the existing frame
CONTEXTUAL_VISUAL_FRAME=REUSED_AND_EXTENDED_EPHEMERAL
REAL_FAILURE_REPRODUCED=YES
REAL_FAILURE_FIXED=YES
FIG_FOLLOWUP_RECALL=PASS
SUBJECT_CORRECTION=PASS
CLARIFICATION_CONTINUATION=PASS
FALSE_POSITIVE_DINNER=PASS
FALSE_POSITIVE_MATH=PASS
FALSE_POSITIVE_WEATHER=PASS
EXPLICIT_LONG_TERM_REGRESSION=PASS
LEGACY_RECALL_REGRESSION=PASS
RECENT_VISUAL_REGRESSION=PASS
MULTI_VISUAL_REGRESSION=PASS
FIVE_INSPECTION_CAP=PASS
ORIGINAL_IMAGE_REOPEN=PASS
LOCAL_BRAIN_REINSPECTION=PASS
HISTORICAL_ATTACHMENT_VISIBLE_COUNT=1
FULL_OBSERVATION_VISIBLE=NO
VISUAL_FINAL_MAX_BUBBLES=2
PET_MEMORY_MODIFIED=NO
VISUAL_DB_SCHEMA_MODIFIED=NO
SCORER_MODIFIED=NO
DREAM_MODIFIED=NO
GALLERY_MODIFIED=NO
PRODUCTION_DEPLOYED=NO
```

专门 fixture 为 `test/v0.4-contextual-visual-recall-followup.mjs`，并已接入
`npm run test:visual-memory-1.2`。澄清无候选时仍执行 Long-Term retrieval，
只有 subject correction/clarification retry 才允许无候选继续进入该链；普通 topic
shift 仍需候选预检，Recent Visual 继续优先。

## 2026-09-07 — Dream Insight Viewer + Visual Gallery

基于 Visual Presentation Cleanup 的 `5772fe1` 建立独立 UI/API 分支。本次只增加
Dream/Reflection 的安全持久化内容展示和 Visual Gallery 只读展示；不运行 Dream，
不触碰 production worktree，不改变 Visual DB schema、PetMemory 语义、视觉检索、
Local Brain、LAN wiring 或 Android。

```text
BASE_COMMIT=5772fe1e5f9d0a46449111aeff104c55160a24ad
BRANCH=feat/dream-gallery-ui
DREAM_INSIGHT_VIEWER=PASS
REFLECTION_DISTINCTION=PRESERVED
VISUAL_GALLERY_READ_ONLY=PASS
VISUAL_GALLERY_LEGACY_ROOTS=PRESERVED
VISUAL_GALLERY_ORIGINAL_BYTES_IN_LIST=NO
VISUAL_OBSERVATION_PROVENANCE=INFERRED
VISUAL_TERMS=BOUNDED_RETRIEVAL_CLUES_ONLY
VISUAL_DB_SCHEMA_CHANGED=NO
PRODUCTION_DATA_MODIFIED=NO
PRODUCTION_CHAT_CREATED=NO
PRODUCTION_DREAM_RUN=NO
PRODUCTION_DEPLOYED=NO
ANDROID_ACCEPTANCE=DEFERRED
```

## 2026-09-07 — Fixed LAN endpoint and WSL forwarding self-heal

本次是独立的 Windows LAN maintenance，不改变 Visual Memory、PetMemory、
Dream、Vision、retrieval、scorer、conversation 数据或 Pet runtime。

```
OFFICIAL_LAN_ENDPOINT=http://192.168.1.175:17870
OFFICIAL_LAN_PORT=17870
WINDOWS_FIXED_LAN_IP=192.168.1.175
IP_STABILITY_METHOD=ROUTER_DHCP_RESERVATION
WSL_FORWARDING=SELF_HEAL_CONNECTADDRESS
SELF_HEAL_SCRIPT=scripts/windows/vc-ai-pet-lan-forwarding-self-heal.ps1
PET_RUNTIME_MODIFIED=NO
VISUAL_MEMORY_MODIFIED=NO
PRODUCTION_DATA_MODIFIED=NO
```

当前 Windows 仍使用 DHCP；DHCP reservation 需要由路由器侧完成。本机
self-heal 在 Windows 不再拥有 .175 时 fail-closed，不会将新地址变成正式
endpoint。Android Companion fresh-install 默认同步为 192.168.1.175:17870，
已有 pet_host preference 保留。完整操作与测试边界见
[LAN_FORWARDING_SELF_HEAL.md](docs/LAN_FORWARDING_SELF_HEAL.md)。

## 2026-09-07 — Visual Memory Phase 1.2（Long-Term Retrieval Precision + Activity Trace Compact）

修复 Android 真机长期视觉复验再次失败：真实根因不是 observation term pollution，
而是 Recent resolver 的 generic boilerplate overlapScore 短路了长期 resolver。
另加中文 2-4 gram、owner exact phrase bonus、observation 归一化/封顶、semantic margin，
以及长期 recall UI 压缩（不再大段 dump observation、final 默认 1 bubble）。
详见 [Phase 1.2 工程日志](docs/DEVLOG_VISUAL_MEMORY_PHASE1_2.md)。

```text
BASE_COMMIT=bfe99edbcdd690465127715379aecdd2063d5eff
BRANCH=feat/visual-memory-phase1.2
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-vm-1.2
REAL_FAILURE_SELECTED_ATTACHMENT=2c910ee2-fc52-48eb-90b0-eb5456b7af35 (Tom&Jerry)
CORRECT_FIG_ATTACHMENT=047fba61-b59e-46f5-a36e-e10c9143d5c8
ROOT_CAUSE=RECENT_BOILERPLATE_OVERLAP_SHORT_CIRCUITS_LONG_TERM
OWNER_EXACT_PHRASE_BONUS=+50/phrase
CHINESE_2_4_GRAM=single=1/bigram=3/trigram=9/4gram=27
SINGLE_CHAR_WEIGHT=0.25 (owner) / 1 (observation)
OBSERVATION_SCORE_NORMALIZED=dedup+bounded
OBSERVATION_SCORE_CAP=ngram=12/single=2
SEMANTIC_MARGIN=abs floor 10 OR relative >=2x
FIG_TOP1=047fba61-b59e-46f5-a36e-e10c9143d5c8
FIG_TOP1_SCORE=50.5
FIG_TOP2_SCORE=1
FIG_MARGIN=49.5
FIG_RESOLUTION=matched
SHINCHAN_RECALL=matched (winner=bb87fc0c, score 11)
SHINCHAN_RELEVANT_AMBIGUITY=allowed for close related images
UNRELATED_IMAGE_WINNER=NO
OBSERVATION_ONLY_LEGACY_RECALL=PASS (蜡笔小新 via observation)
LONG_TERM_ACTIVITY_MAX_VISIBLE_STEPS=recall + image + short re-look + final
FULL_OBSERVATION_VISIBLE_TO_USER=NO
FULL_OBSERVATION_STILL_PERSISTED=YES (inferred event)
LONG_TERM_FINAL_BUBBLES=1 (max 2)
RECENT_VISUAL_REGRESSION=PASS
MULTI_VISUAL_A_B_A=PASS
FIVE_INSPECTION_CAP=PASS
DEFERRED_TIMESTAMP_LEAK=PRESERVED
PRODUCTION_DATA_MODIFIED=NO
PRODUCTION_CHAT_CREATED=NO
PRODUCTION_DEPLOYED=NO
```

## 2026-09-06 — Visual Memory Phase 1.1（legacy semantic index + recall routing fix）

修复 Android 真机长期视觉验收失败：zero-model 导入 15 条旧 safe observation、
修正 bigram stop 规则与 generic recall term 抑制、增加短追问 ephemeral recall context。
详见 [Phase 1.1 工程日志](docs/DEVLOG_VISUAL_MEMORY_PHASE1_1.md)。

```text
BASE_COMMIT=19b2c2cb932e128477f96c763e012474b4c3ecf5
BRANCH=feat/visual-memory-phase1.1
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-vm-1.1
LEGACY_OBSERVATIONS_TOTAL=15
LEGACY_OBSERVATIONS_MAPPED=10
LEGACY_OBSERVATIONS_SKIPPED_AMBIGUOUS=5
PRODUCTION_RUNTIME_WIRING=PASS
PRODUCTION_PATH_RUNTIME_INIT_TEST=PASS
MODEL_CALLS_DURING_MIGRATION=0
MIGRATION_IDEMPOTENT=YES
SEMANTIC_COVERAGE_BEFORE=22/31
SEMANTIC_COVERAGE_AFTER=25/31
STOP_BIGRAM_RULE_FIXED=YES
GENERIC_RECALL_TERMS_SUPPRESSED=YES
FIG_QUERY_TOP1=047fba61-b59e-46f5-a36e-e10c9143d5c8
FIG_QUERY_RESOLUTION=matched
SHINCHAN_RESOLUTION=matched（winner=bb87fc0c，无关图全被压到 score=1）
FOLLOWUP_ROUTING=PASS（有很多无花果 / 那蜡笔小新呢 / 那晚饭呢不误触发）
ASSISTANT_HINT_IMPLEMENTED=NO（DEFERRED）
LEGACY_LAZY_VLM_BOOTSTRAP=DEFERRED
RECENT_VISUAL_REGRESSION=PASS
MULTI_VISUAL_A_B_A=PASS
FIVE_INSPECTION_CAP=PASS
PRODUCTION_DATA_MODIFIED=NO
PRODUCTION_CHAT_CREATED=NO
PRODUCTION_DREAM_RUN=NO
PRODUCTION_DEPLOYED=NO
```

## 2026-09-06 — Visual Memory Phase 1

李花花拥有长期视觉经历：历史图片进 Visual Experience Index（zero-inference
backfill），长期回想找到候选后重新打开真正原图再回答；旧 observation 只辅助
retrieval；Dream/Reflection 只拿 bounded RAW/INFERRED visual context。
详见 [Visual Memory Phase 1 工程日志](docs/DEVLOG_VISUAL_MEMORY_PHASE1.md)
与 [Agent Handoff 协议](docs/AGENT_HANDOFF_PROTOCOL.md)。

```text
BASE_COMMIT=ce566c506a9d496ea5ee543b73f28232269c5c99
INTEGRATION_BRANCH=feat/visual-memory-phase1
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-visual-memory
AGENT_HANDOFF=/home/vitamin_c/projects/personal/vc-ai-pet-agent-share
VISUAL_DB=visual-experience.db
ZERO_INFERENCE_BACKFILL=PASS
LONG_TERM_VISUAL_RECALL=PASS
RECENT_VISUAL_PRIORITY=PRESERVED
ORIGINAL_IMAGE_REOPEN=PASS
OLD_CAPTION_AS_FINAL_EVIDENCE=NO
VISUAL_OBSERVATION_PROVENANCE=inferred
REPEATED_IMAGE_RAW_ROOT_DEDUP=PASS
DREAM_VISUAL_CONTEXT=BOUNDED_RAW_INFERRED
REFLECTION_VISUAL_CONTEXT=BOUNDED_RAW_INFERRED
OVER_500_MESSAGES_RECALL=PASS
RESTART_RECALL=PASS
MISSING_ASSET=HONEST
ASSISTANT_EVIDENCE_EXCLUDED=PASS
MULTI_VISUAL_REGRESSION=PASS
A_TO_B_TO_A=PASS
FIVE_INSPECTION_CAP=PASS
MODEL_CALLS_DURING_BACKFILL=0
PRODUCTION_DATA_MODIFIED=NO
PRODUCTION_DREAM_RUN=NO
DEFERRED_BUGS_PRESERVED=YES
PRODUCTION_DEPLOYED=NO
```

## 2026-09-05 — Long-term cognition phase 1

The delivered scope is durable raw conversation history, temporal owner
beliefs, source-backed direct belief answers, evidence-rooted weak Self
hypotheses, Dream/Reflection loop guards and a user-facing inner-life timeline.
See [phase design and acceptance](docs/LONG_TERM_COGNITION_PHASE1.md).

```text
BASELINE_BRANCH=feat/visual-working-session
BASELINE_HEAD=50789e0fd15854c2e45aa89a4fc1d07f45b7fb4c
BRANCH=feat/long-term-cognition
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-cognition
CURRENT_BELIEF=supported/contested/temporary/unknown
RAW_HISTORY=SQLITE_ARCHIVE_PLUS_BOUNDED_RECENT_CACHE
SELF=WEAK_INFERRED_HYPOTHESES_FROM_DISTINCT_RAW_ROOTS
DERIVED_SELF_REINFORCEMENT=GUARDED
DREAM_UI=PLAY_TOP_ENTRY_AND_PAGINATED_TIMELINE
REFLECTION_UI=SMALL_THOUGHTS_IN_SAME_TIMELINE
EXISTING_TEST_PROGRAMS=25_PASS_AFTER_INTENTIONAL_CONTRACT_UPDATES
LONG_LIFE_TEST_PROGRAMS=4_PASS
REAL_LOCAL_BRAIN_CHANGE_AND_RECALL=PASS_IN_TEMP_SANDBOX
CLIENT_BUILD_AND_VERIFY=PASS
NARROW_SCREEN_RENDER_QA=UNVERIFIED_CHROMIUM_NAVIGATION_TIMEOUT
PRODUCTION_DATA_MODIFIED=NO
PRODUCTION_DREAM_RUN=NO
PRODUCTION_HOST_RESTARTED=NO
ANDROID_NATIVE_CHANGED=NO
LOCAL_BRAIN_API_CHANGED=NO
GOMOKU=DEFERRED
INITIATIVE_AND_BACKGROUND_NOTIFICATIONS=DEFERRED
ARCHIVE_WIDE_VISUAL_EXPERIENCE_RETRIEVAL=DEFERRED
```

Runtime audit found **two** DSH Host processes opening the production Pet DB.
The LAN Host predates the latest source modifications, so its loaded code is
not verified equal to source. This branch was tested independently and has not
been activated in that production Host. No reset, force push, or replacement
of the original checkout was used. Older acceptance sections below are
historical snapshots, not a current service-status assertion.

Additional fixes: old 500-message deletion became a bounded cache plus durable
archive; new MemoryGate writes retain actual evidence instead of model
paraphrases; questions/assistant quotations cannot become facts; historical
and current-Self reads retain provenance; out-of-order cognition completion
does not overwrite newer owner evidence; zero-sized history reads return empty.

The explicit product adjustment is staged delivery, plus a narrow evidence
answer renderer because live Local Brain testing showed correct retrieval did
not guarantee a correct final answer. No claims are made of universal semantic
contradiction resolution, retroactive restoration of deleted data, full Self
revision or Android device acceptance.

## Historical baseline

```text
DSH_VERSION=0.1.1-rc.2
REPO_PATH=/home/vitamin_c/projects/personal/vc-ai-pet
GITHUB_REPO=https://github.com/Vitamin-C-lv/vc-ai-pet
GITHUB_VISIBILITY=PUBLIC
DSH_PLUGIN_INSTALL_PATH=/home/vitamin_c/.dsh/profiles/web/node_modules/vc-ai-pet
PET_SANDBOX=/home/vitamin_c/.local/share/vc-ai-pet/sandbox
PET_MEMORY_DB=/home/vitamin_c/.local/share/vc-ai-pet/sandbox/memory/pet-memory.db
DSH_MEMORY_DB=/home/vitamin_c/桌面/测试/.dsh-meow/memory.db
PET_ACTIVE_DSH_HOST_COUNT=1
SINGLE_CLICK_EXACTLY_ONCE=PASS
DOUBLE_CLICK_EXACTLY_ONCE=PASS
CLIENT_HOST_RPC=PASS
CLICK_INTERACTION=PASS
MULTI_CLICK_COUNT_CONSISTENCY=PASS
DATABASES_SEPARATE=YES
PERSISTENCE=PASS
DEEPSEEK_REQUESTS_FROM_PET=0
CONVERSATION_INJECTION=NONE
MODEL_TOOL_REGISTERED=NO
LUNA_REGRESSION=PASS
TOOL_FOLD_REGRESSION=PASS
MULTI_DSH_BACKEND_CONCURRENT_WRITE=OUT_OF_SCOPE_V0_1
CURRENT_COMMIT=UI_RELEASE_COMMIT_RECORDED_IN_GIT
```

Interaction acceptance recorded:

- Single-click baseline: `lifetimeInteractions=9`, `attachment=0.578`, `fact_count=27`.
- Single-click result: `lifetimeInteractions=10`, `attachment=0.584`, `fact_count=28`; latest fact is `主人和我互动了：pet。累计互动次数：10。`.
- Double-click acceptance: one logical `play` interaction, as confirmed by the user; no further interaction testing is required for v0.1.

The package remains isolated from DSH memory and model activity. v0.1 does not include local LLM, VLM, Dream, Reflection, DSH event awareness, or computer control. Luna Team and `vc-tool-activity-fold` remain unchanged.

## v0.3-A implementation status

Recent Conversation Continuity is implemented on branch
`feat/v0.3-recent-conversation` as a host-side RAM-only buffer of the latest
12 successful user/assistant turns. It is not persisted to the sandbox or any
memory database. Automated and manual acceptance are complete; the package
version is `0.3.0-alpha.1`.

## v0.3-B Dream / Reflection status

The feature branch `feat/v0.3-dream` adds two independent, Pet-only thought
layers. Micro Reflection uses a separate 30-minute checkpoint and a maximum of
4 new raw memories, 4 related rows, and 1 additive derived row. Deep Dream is
restricted to sleep, uses a 15-minute sleep minimum, allows night runs from
22:30 to 08:00 or a daytime nap after 45 minutes of continuous fixed GPU
availability, and uses 24 new / 24 related rows per batch with at most 3
derived rows. Both layers use only Local Brain API v1 at
`http://127.0.0.1:17862`; neither writes `rules` or uses physical context.

Acceptance is complete on `feat/v0.3-dream`:

```text
VERSION=0.3.0-alpha.2
DREAM_SOURCE_SESSION=vc-ai-pet:dream
DREAM_WINDOW=vc-ai-pet:dream-window
REFLECTION_SOURCE_SESSION=vc-ai-pet:reflection
REFLECTION_WINDOW=vc-ai-pet:reflection-window
CHECKPOINTS_INDEPENDENT=PASS
RAW_MEMORY_HISTORY_PRESERVED=PASS
EMERGENT_SOUL=PASS
SOUL_WRITE_FROM_CHAT=DENIED
SOUL_WRITE_FROM_REFLECTION=DENIED
SOUL_WRITE_FROM_DREAM=ALLOWED_GATED
PRODUCTION_DREAM_ACCEPTANCE=PASS
PRODUCTION_DREAM_SOURCE_COUNT=4
PRODUCTION_DREAM_BATCH_COUNT=1
PRODUCTION_DREAM_DERIVED_COUNT=2
PRODUCTION_DREAM_DUPLICATE_COUNT=1
```

The production `dream_log` entry is additive and records
`changes.kind=dream`; no raw chat transcript or source-row rewrite occurred.

## v0.3-C Historical Recall

The feature branch `feat/v0.3-historical-recall` adds an on-demand historical
read path above the sealed v0.3-B Dream/Reflection layers. Normal chat keeps
`memory.recall(userText, 5)` and does not scan all history or read `dream_log`.
Historical questions use deterministic intent routing, meow-memory BM25
retrieval over `soul/user/project/fact/lesson/topic`, temporal ordering, and a
bounded read-only provenance expansion from the existing `dream_log`.

```text
VERSION=0.3.0-alpha.3
HISTORICAL_RECALL_MODE=ON_DEMAND_ONLY
HISTORICAL_SEARCH_MAX=12
HISTORICAL_LINEAGE_MAX_DEPTH=3
HISTORICAL_LINEAGE_MAX_NODES=18
HISTORICAL_CONTEXT_MAX=16
DREAM_PROVENANCE=EXISTING_DREAM_LOG
PROVENANCE_DB_WRITE=NO
NEW_PROVENANCE_DB=NO
RAW_SOURCE_PRIORITY=PASS
CONTRADICTION_HANDLING=TEMPORAL_READ_ONLY
FULL_MEMORY_CONTEXT_INJECTION=NO
NORMAL_CHAT_HISTORICAL_SCAN=0
NORMAL_CHAT_DREAM_LOG_READS=0
RAW_CHAT_HISTORY_PERSISTED=NO
MODEL_INFERENCES_PER_CHAT=1
PET_DEEPSEEK_REQUESTS=0
```

Historical Recall is read-only: it does not create derived memory, mutate
source rows, update status, touch Dream/Reflection checkpoints, or append
`dream_log`. The prompt exposes short source labels and readable timestamps;
it does not claim compressed memory content is a persisted raw transcript.

## v0.3-C Pet-side Busy Gate Removal

```text
FINAL_STATUS=VC_AI_PET_V0_3_C_UI_PENDING
PET_API_CALL_POLICY=DIRECT
PET_API_DIRECT_CALL=PASS
CHAT_GPU_BUSY_GATE=REMOVED
REFLECTION_GPU_BUSY_GATE=REMOVED
DREAM_GPU_BUSY_GATE=REMOVED
DAYTIME_NAP_TRIGGER=SLEEP_DURATION_45M
LOCAL_BRAIN_REQUEST_TIMEOUT_MS=180000
QUEUE_FULL_RETRY=250/500/1000ms
QUEUE_FULL_RETRY_BOUNDED=PASS
OWNER_BUSY_CANNED_REPLY=REMOVED_FROM_PRODUCTION
HISTORICAL_RECALL_AUTO_TESTS=PASS
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DREAM_RERUN=NO
```

The Pet layer now sends Chat, Reflection, and Dream requests directly to the
loopback Local Brain API. GPU utilization, VRAM, and owner-busy state no longer
produce a Pet-side admission decision; the API queue owns that scheduling.

## v0.3-D Phase 1 Memory Consolidation Foundation

v0.3-D Phase 1 is complete. The foundation adds Memory Provenance metadata,
Semantic Stability validation for derived memories, and an explicit Dream
Candidate layer before derived-memory approval. Existing `source_session`
values remain readable, and Assistant Response provenance cannot become a
confirmed memory.

```text
FINAL_STATUS=VC_AI_PET_V0_3_D_PHASE1
MEMORY_PROVENANCE=PASS
SEMANTIC_STABILITY=PASS
DREAM_CANDIDATE_LAYER=PASS
LEGACY_MEMORY_COMPATIBILITY=PASS
PRODUCTION_DB_MODIFIED=NO
DREAM_RERUN=NO
```

Deferred to v0.3-D Phase 2: Reflection Engine, Personality Emergence, and
Contradiction Detection. These require accumulated real long-term interaction
data before the next consolidation layer is developed.

## v0.3-E Phase 1 UI / Visual Presence

The overlay now owns a small, presentation-only visual state layer. It keeps
the existing persistent pet state unchanged and chooses exactly one state in
this order: `dreaming`, `thinking`, `excited`, `happy`, `sleep`, `walk`, then
`idle`. Dream status is a read-only report of the actual `DreamEngine`
in-flight flag; it is never inferred from clock time or written to storage.

```text
FINAL_STATUS=VC_AI_PET_V0_3_E_PHASE1_PASS
VERSION=0.3.0-alpha.4
VISUAL_STATE_PRIORITY=CENTRALIZED
VISUAL_IDLE=PASS
VISUAL_THINKING=PASS
VISUAL_SLEEP=PASS
VISUAL_DREAMING=PASS
VISUAL_HAPPY=PASS
VISUAL_EXCITED=PASS
VISUAL_WALK=PASS
ENV_NIGHT_TIME=PASS
ENV_LONG_NO_INTERACTION=PASS
ENV_CHAT_PENDING=PASS
ENV_DREAM_RUNNING=PASS
ENV_OWNER_WORKING=PASS
ENVIRONMENT_CONTENT_READS=NONE
OVERLAY_INTERACTION_TEST=PASS
CLIENT_BUNDLE_VERIFY=PASS
CHAT_BUBBLE_REGRESSION=PASS
CLICK_REGRESSION=PASS
DOUBLE_CLICK_REGRESSION=PASS
DRAG_REGRESSION=PASS
LUNA_REGRESSION=PASS
TOOL_FOLD_REGRESSION=PASS
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DREAM_RERUN=NO
```

`ownerWorking` is deliberately only a weak UI label: long pet inactivity,
daytime, and a visible DSH page. It does not inspect titles, content,
clipboard, files, or any other user data, and it cannot affect Local Brain or
Dream decisions. `readPresence` is an additive package-private RPC for the
browser overlay; it exposes only boolean `chatPending` and `dreamRunning`
flags plus the UI-only visual configuration.

## v0.3-E Phase 2 — Emotion & Living Interaction Layer

The browser overlay now keeps a momentary emotion runtime in React memory. It
uses only owner interactions, elapsed time, the read-only Dream in-flight flag,
and the existing attachment value as an initial/refresh hint. The runtime is
never written to `pet-memory.db`, `state.json`, localStorage, the Local Brain,
or conversation/memory paths.

```text
FINAL_STATUS=VC_AI_PET_V0_3_E_PHASE2_PASS
EMOTION_RUNTIME=PASS
CLICK_FEEDBACK=PASS
DOUBLE_CLICK_FEEDBACK=PASS
LONG_PRESS_FEEDBACK=PASS
INTERACTION_BURST=PASS
WAITING_STATE=PASS
IDLE_RANDOM_ACTION=PASS
DREAM_VISUAL_ENHANCEMENT=PASS
VISUAL_IDLE=PASS
VISUAL_HAPPY=PASS
VISUAL_EXCITED=PASS
VISUAL_RELAXED=PASS
VISUAL_WAITING=PASS
VISUAL_CONFUSED=PASS
CHAT_BUBBLE_REGRESSION=PASS
CLICK_REGRESSION=PASS
DOUBLE_CLICK_REGRESSION=PASS
DRAG_REGRESSION=PASS
LUNA_REGRESSION=PASS
TOOL_FOLD_REGRESSION=PASS
PRODUCTION_DB_MODIFIED=NO
MEMORY_SCHEMA_CHANGED=NO
LOCAL_BRAIN_API_CHANGED=NO
```

The 30-second burst detector is bounded to happy (1–5), excited (6–15), and
curious/confused (>15) feedback; it never emits a negative owner judgement.
Long press is a relaxed visual-only interaction and does not create an extra
host persistence event. Waiting is silent and appears only when chat is closed
after a recent interaction. Idle actions are weighted and scheduled by one
low-frequency timeout in the browser.

## v0.3-E Phase 3-A LAN Companion UI

```text
FINAL_STATUS=VC_AI_PET_V0_3_E_PHASE3A_PASS
LAN_SERVER=PASS
MOBILE_UI=PASS
STATE_SYNC=PASS
CHAT_SYNC=PASS
CLICK_SYNC=PASS
DOUBLE_CLICK_SYNC=PASS
LONG_PRESS_SYNC=PASS
EMOTION_SYNC=PASS
DREAM_SYNC=PASS
LOCAL_ONLY=PASS
PUBLIC_NETWORK_BIND=NO
CHAT_BUBBLE_REGRESSION=PASS
CLICK_REGRESSION=PASS
DOUBLE_CLICK_REGRESSION=PASS
DRAG_REGRESSION=PASS
EMOTION_RUNTIME_REGRESSION=PASS
LUNA_REGRESSION=PASS
TOOL_FOLD_REGRESSION=PASS
MEMORY_SCHEMA_CHANGED=NO
LOCAL_BRAIN_API_CHANGED=NO
```

The host-owned LAN listener uses `0.0.0.0:17870` only to accept devices on the
local network. It rejects every client except localhost and private IPv4
(`10/8`, `172.16/12`, `192.168/16`). The mobile page polls every 1.5 seconds;
it calls the same runtime interaction and chat methods as the desktop overlay.

## Current DSH background Reflection loop hotfix

The DSH-hosted Pet Reflection request was exhausting its 500-token completion
budget with the Relay's low-thinking profile (`finish_reason=length`), leaving
the reflection checkpoint unchanged and causing the 10-second host tick to
retry. Reflection now uses the existing `off` profile so the bounded budget is
reserved for its structured JSON; normal Chat remains `off`, and Deep Dream
remains `medium`. Both idle DSH Web instances were reloaded from the working
tree without restarting llama or Relay. The LAN/state surfaces remained
available and no Relay activity was observed during the post-reload window.

```text
REFLECTION_THINKING=OFF
NORMAL_CHAT_CONTRACT=UNCHANGED
DEEP_DREAM_CONTRACT=UNCHANGED
DSH_3082_RELOADED=PASS
DSH_3080_RELOADED=PASS
LOCAL_BRAIN_RELAY_RESTARTED=NO
LLAMA_RESTARTED=NO
POST_RELOAD_PERIODIC_REQUESTS=0_OBSERVED
```

## v0.3-E Current Time Context Hotfix

The Local Brain now receives one ephemeral snapshot of the real local system
clock on every chat reply. The snapshot contains `currentDate`, `currentTime`,
`weekday`, `dayPeriod`, and `season`; it is system environment context rather
than memory or user-provided content. The same provider is reused by the
presentation layer's night-time check. It is not written to `pet-memory.db`
and is not passed into Dream or Historical Recall input builders.

```text
FINAL_STATUS=VC_AI_PET_TIME_CONTEXT_PASS
TIME_PROVIDER=PASS
LOCAL_BRAIN_TIME_CONTEXT=PASS
MEMORY_SCHEMA_CHANGED=NO
DREAM_CHANGED=NO
```

## Vision Input v0.1 — LAN owner-triggered image chat

The LAN companion chat now accepts one owner-selected JPEG, PNG, or WebP per
turn. The browser downsizes images to a maximum 1920px long edge and exports
WebP (or JPEG fallback) before sending the additive `image.dataUrl` field to
the existing `/api/pet/chat` route. The server accepts only approved base64
image data URLs, keeps the larger body limit scoped to Chat, and never exposes
filesystem paths or remote URLs.

Vision turns use the existing Local Brain API v1 multimodal message contract
and exactly one inference. The image is request-only: Recent Conversation
stores only `[主人发送了一张图片]` plus any actual owner text, and the
MemoryGate is skipped for vision turns so neither image bytes nor visual
inferences become Pet memory.

```text
FINAL_STATUS=VC_AI_PET_VISION_INPUT_V0_1_AUTOMATED_PASS
LAN_IMAGE_PICKER=PASS
IMAGE_PREVIEW=PASS
IMAGE_REMOVE=PASS
IMAGE_ONLY_CHAT=PASS
IMAGE_PLUS_TEXT_CHAT=PASS
LOCAL_BRAIN_VISION=PASS
MODEL_INFERENCES_PER_CHAT=1
SUPPORTED_IMAGE_TYPES=JPEG,PNG,WEBP
MAX_IMAGES_PER_TURN=1
IMAGE_LONG_EDGE_MAX=1920
RAW_IMAGE_PERSISTED=NO
IMAGE_BASE64_IN_RECENT_CONVERSATION=NO
IMAGE_BASE64_IN_PET_MEMORY=NO
VISION_DERIVED_MEMORY_WRITE=NO
TEXT_CHAT_REGRESSION=PASS
DREAM_REGRESSION=PASS
HISTORICAL_RECALL_REGRESSION=PASS
UI_PRESENCE_REGRESSION=PASS
EMOTION_REGRESSION=PASS
LAN_COMPANION_REGRESSION=PASS
MANUAL_REAL_PHOTO_ACCEPTANCE=PENDING
```

## Vision v0.1 — real-image E2E diagnosis

The first real-image failure was isolated to a stale DSH Web host: the
running host had started before the Vision commits, so its already-loaded LAN
handler still rejected an image-only chat as `invalid-message`. Static mobile
assets were current because they are read per request, which made the stale
handler easy to miss. The DSH host was reloaded to the current `d77a242`
working tree without restarting Relay or llama.

A generated 128×128 red/blue PNG (390 bytes) then passed the complete LAN →
PetRuntime → Local Brain path. A direct Local Brain v1 probe passed both
without `response_format` and with the current Pet JSON response format, so no
Vision compatibility workaround or lower-layer change was needed. Vision
turns retain one inference and skip MemoryGate; image bytes remain request
only. Internal failure logging now records only code, retryable, and request ID
without returning or logging image/prompt/response content.

```text
REAL_IMAGE_E2E=PASS_FOR_CURRENT_RELOADED_HOST
ROOT_CAUSE_LAYER=STALE_DSH_HOST_NOT_RELOADED
ROOT_CAUSE=RUNNING_HOST_PREDATED_VISION_COMMIT
LAN_TINY_PNG=PASS
PET_RUNTIME_TINY_PNG=PASS
LOCAL_BRAIN_MINIMAL_VISION=PASS
VISION_NO_RESPONSE_FORMAT=PASS
VISION_WITH_RESPONSE_FORMAT=PASS
LOCAL_BRAIN_VISION_REGRESSION=NO
MOBILE_REAL_PHOTO=PENDING_USER_RETEST
INTERNAL_ERROR_CODE_LOGGING=PASS
IMAGE_CONTENT_LOGGED=NO
PRODUCTION_DB_MODIFIED=NO
DREAM_RERUN=NO
```

## v0.3-F — Conversation Persistence

The LAN companion now has an independent Conversation Persistence Layer. The
store is separate from `pet-memory.db`, stores short-term message records and
local date-partitioned image assets, and is not read by Memory, Historical
Recall, Dream, Reflection, Local Brain, or Emotion Runtime. The mobile page
loads the latest 50 records on startup and renders persisted user images from
thumbnail URLs after a browser refresh.

```text
FINAL_STATUS=VC_AI_PET_CONVERSATION_PERSISTENCE_PASS
VERSION=0.3.0-alpha.5
CONVERSATION_STORE=conversation-store.json
CONVERSATION_ASSETS=conversation-assets/YYYY/MM/DD
CONVERSATION_HISTORY_LIMIT=50
CONVERSATION_IMAGE_MAX_EDGE=1920
CONVERSATION_THUMBNAIL_MAX_EDGE=256
CONVERSATION_BASE64_PERSISTED=NO
HISTORY_API=/api/pet/history
IMAGE_UPLOAD_API=/api/pet/upload
USER_RECORD_BEFORE_LOCAL_BRAIN=PASS
REFRESH_HISTORY=PASS
IMAGE_THUMBNAIL_RENDERING=PASS
MEMORY=UNCHANGED
DREAM=UNCHANGED
HISTORICAL_RECALL=UNCHANGED
LOCAL_BRAIN_API=UNCHANGED
EMOTION_RUNTIME=UNCHANGED
```

## v0.3-F — Mobile App Shell / Chat & Play Split

The LAN companion mobile page now uses a full-screen two-view app shell. Play
and Chat are mutually exclusive views under one global header, with a normal
content bottom navigation. The selected tab is restored from
`vc-ai-pet-mobile-active-tab-v1`; missing or invalid values default to Play.
Tab changes only update DOM visibility and selection state, so chat drafts,
selected image previews, message scroll position, and pet presentation state
remain intact. Chat fills the active area and assigns scrolling only to the
message list; the old 220px message cap is removed.

```text
FINAL_STATUS=VC_AI_PET_MOBILE_APP_SHELL_PASS
APP_SHELL=PASS
PLAY_VIEW=PASS
CHAT_VIEW=PASS
BOTTOM_NAV=PASS
DEFAULT_TAB=PLAY
TAB_PERSISTENCE=PASS
TAB_SWITCH_NO_RELOAD=PASS
BODY_SCROLL=LOCKED
PLAY_VIEW_NORMAL_SCROLL=NO
CHAT_VIEW_SCROLL_OWNER=MESSAGES_ONLY
CHAT_COMPOSER_FIXED_IN_VIEW=PASS
IMAGE_PREVIEW_PERSISTS_ACROSS_TAB_SWITCH=PASS
MOBILE_UI_CONTRACT=PASS
MOBILE_NARROW_VIEWPORT=PASS
WEB_UI_UPDATE_WITHOUT_APK_REINSTALL=PASS
ANDROID_NATIVE_CHANGED=NO
APK_REBUILT=NO
APK_REINSTALLED=NO
PET_CORE_CHANGED=NO
MEMORY_CHANGED=NO
DREAM_CHANGED=NO
HISTORICAL_RECALL_CHANGED=NO
LOCAL_BRAIN_CHANGED=NO
CONVERSATION_STORE_CHANGED=NO
LAN_SERVER_CHANGED=NO
```

Production changes are limited to the three LAN mobile UI files. The
Conversation Persistence Layer, Memory, Dream, Historical Recall, Local Brain
API, Emotion Runtime, and Android Companion remain unchanged.

## v0.3-F — Mobile UI Polish Phase 2

The LAN companion mobile UI now hides the bottom navigation while the Chat
composer has focus on a mobile viewport. VisualViewport resize/scroll events,
window resize, focus lifecycle, and a conservative legacy-WebView fallback are
coalesced into a `keyboard-open` root state. During that state the navigation
releases its layout height and the shell tracks the visible viewport without
allowing body scrolling.

Play has a compact stage/actions composition with an explicit hint, a larger
centered sprite, closer status metrics, and a 6–8% bottom breathing buffer.
Chat messages retain the existing article data flow while rendering through a
shared `.message-bubble`; owner and pet bubbles have distinct warm tones and
images remain inside the same message block as accompanying text.

```text
FINAL_STATUS=VC_AI_PET_MOBILE_UI_POLISH_PHASE2_PASS
KEYBOARD_NAV_HIDE=PASS
PLAY_LAYOUT_REBALANCE=PASS
CHAT_BUBBLES=PASS
CHAT_COMPOSER_STABLE=PASS
BOTTOM_NAV_POLISH=PASS
IMAGE_PREVIEW_UI=PASS
TEXT_CHAT_REGRESSION=PASS
IMAGE_CHAT_REGRESSION=PASS
PLAY_INTERACTION_REGRESSION=PASS
TAB_PERSISTENCE=PASS
APK_REBUILD_REQUIRED=NO
ANDROID_NATIVE_CHANGED=NO
PET_CORE_CHANGED=NO
MEMORY_CHANGED=NO
DREAM_CHANGED=NO
LOCAL_BRAIN_CHANGED=NO
RELAY_CHANGED=NO
CONVERSATION_STORE_CHANGED=NO
LAN_SERVER_CHANGED=NO
```

## v0.1 Android Companion

The Android Companion is a thin native shell around the existing LAN Companion
Web UI. It adds no Pet business implementation and does not package HTML, CSS,
JavaScript, conversation data, or model code into the APK. The host is editable
and only the normalized `host:port` value is stored in Android
`SharedPreferences` under `pet_host`.

```text
ANDROID_COMPANION_STATUS=IMPLEMENTED_PENDING_USER_DEVICE_ACCEPTANCE
ANDROID_COMPANION_BRANCH=feat/android-companion
CHANGED_FILES=android-companion/,PROJECT_STATE.md
ANDROID_PROJECT=PASS
GRADLE_WRAPPER=PASS
DEBUG_APK_BUILD=PASS
ANDROID_LINT=PASS_WITH_EXPECTED_WARNINGS
WEBVIEW=PASS
JAVASCRIPT=PASS
DOM_STORAGE=PASS
FILE_ACCESS_DISABLED=PASS
JAVASCRIPT_BRIDGE=NONE
LAN_HOST_CONFIG=PASS
LAN_CLEAR_TEXT=PASS
PUBLIC_NAVIGATION_BLOCKED=PASS
IMMERSIVE_FULLSCREEN=PASS
PORTRAIT_MODE=PASS
BACK_NAVIGATION=PASS
ANDROID_FILE_CHOOSER=IMPLEMENTED_PENDING_USER_DEVICE_ACCEPTANCE
ANDROID_PERMISSIONS=INTERNET
ADB_DEVICE=NOT_CONNECTED
APK_PATH=android-companion/dist/李花花-Android-Companion-v0.1-debug.apk
APK_SIZE_BYTES=2545700
PET_CORE_CHANGED=NO
MEMORY_CHANGED=NO
DREAM_CHANGED=NO
LOCAL_BRAIN_CHANGED=NO
WEB_UI_UPDATE_WITHOUT_APK_REINSTALL=PENDING_USER_DEVICE_ACCEPTANCE
TEXT_CHAT=PENDING_USER_DEVICE_ACCEPTANCE
VISION_REPLY=PENDING_USER_DEVICE_ACCEPTANCE
CONVERSATION_HISTORY=PENDING_USER_DEVICE_ACCEPTANCE
IMAGE_HISTORY=PENDING_USER_DEVICE_ACCEPTANCE
COMMIT=RECORDED_IN_GIT
REMOTE_HEAD=PUSHED_TO_ORIGIN
PUSH=PASS
```

## v0.3-G — Reasoning Profiles + Thinking Feedback

Interactive Pet inference now uses one centralized reasoning profile: ordinary
text chat is `low`, Vision chat is `medium`, Dream is `high`, and Reflection
remains `off`. LocalBrain measures monotonic request duration around the single
Local Brain call, including bounded queue retry waits. The LAN/mobile API
passes only the structured `reasoning.effort` and `reasoning.durationMs`
telemetry; Conversation Store and Memory schemas remain unchanged.

Both the LAN Companion and DSH desktop bubble insert a pet-style temporary
thinking message with paw/dot motion, remove it on success or failure, and show
the completed duration below successful Pet replies. The existing
`chatPending`/host presence link still drives the Pet `thinking` visual state.

```text
FINAL_STATUS=VC_AI_PET_REASONING_AND_THINKING_UI_PASS
TEXT_REASONING=low
VISION_REASONING=medium
DREAM_REASONING=high
REFLECTION_REASONING=off
TEXT_REASONING_LOW=PASS
VISION_REASONING_MEDIUM=PASS
DREAM_REASONING_HIGH=PASS
REFLECTION_REASONING_OFF=PASS
MODEL_INFERENCES_PER_CHAT=1
THINKING_TIMER=PASS
THINKING_DURATION_SOURCE=PET_LOCAL_BRAIN_REQUEST
THINKING_DURATION_INCLUDES_QUEUE_WAIT=YES
THINKING_DURATION_PERSISTED=NO
MOBILE_THINKING_INDICATOR=PASS
MOBILE_THINKING_ANIMATION=PASS
MOBILE_THINKING_DURATION=PASS
DESKTOP_THINKING_INDICATOR=PASS
DESKTOP_THINKING_DURATION=PASS
PET_THINKING_VISUAL_STATE=PASS
VISION_THINKING_COPY=PASS
DREAM_UI_REGRESSION=PASS
VISION_REGRESSION=PASS
TEXT_CHAT_REGRESSION=PASS
CONVERSATION_REGRESSION=PASS
MOBILE_UI_REGRESSION=PASS
CHAIN_OF_THOUGHT_EXPOSED=NO
ANDROID_NATIVE_CHANGED=NO
APK_REBUILT=NO
APK_REINSTALLED=NO
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DREAM_RERUN=NO
BRANCH=feat/mobile-app-shell
COMMIT=RECORDED_IN_GIT
REMOTE_HEAD=PUSHED_TO_ORIGIN
WORKTREE=CLEAN_AFTER_COMMIT
```

## v0.3-H — Recent Visual Recall + Persistent Thinking Duration

Thinking duration is now sanitized into optional assistant-message metadata in
the independent Conversation Store. Existing messages without the field remain
valid, and the mobile history renderer displays `🐾 思考了 X.X 秒` for both live
and refreshed assistant replies without exposing reasoning effort.

Recent Visual Resolver keeps the latest ten owner messages that carry an
attachment, resolves only on an explicit visual reference or an immediate weak
follow-up, and materializes at most one full stored asset. New images take
priority; recalled images are never attached to the new user message. The
resolver is persistent across runtime restart, does not put base64 into Recent
Conversation or the JSON store, and skips MemoryGate for visual context.

```text
FINAL_STATUS=VC_AI_PET_RECENT_VISUAL_RECALL_PASS
LIVE_THINKING_DURATION=PASS
THINKING_DURATION_PERSISTED=YES
THINKING_DURATION_STORAGE=CONVERSATION_METADATA_ONLY
THINKING_DURATION_AFTER_REFRESH=PASS
RECENT_VISUAL_RECALL=PASS
RECENT_VISUAL_MAX_ATTACHMENTS=10
RECENT_VISUAL_SOURCE=CONVERSATION_STORE
RECENT_VISUAL_BASE64_PERSISTED_IN_CONTEXT=NO
LATEST_IMAGE_FOLLOWUP=PASS
STRONG_VISUAL_REFERENCE=PASS
WEAK_IMMEDIATE_REFERENCE=PASS
UNRELATED_CHAT_NO_VISUAL_RECALL=PASS
RECENT_VISUAL_RECALL_AFTER_RESTART=PASS
CURRENT_IMAGE_PRIORITY=PASS
HISTORICAL_IMAGE_DUPLICATED_IN_CONVERSATION=NO
MODEL_INFERENCES_PER_CHAT=1
TEXT_REASONING=low
VISION_REASONING=medium
RECALLED_VISION_REASONING=medium
DREAM_REASONING=high
REFLECTION_REASONING=off
VISUAL_RECALL_MEMORY_WRITE=NO
PET_MEMORY_CHANGED=NO
DREAM_CHANGED=NO
LOCAL_BRAIN_API_CHANGED=NO
ANDROID_NATIVE_CHANGED=NO
APK_REBUILT=NO
APK_REINSTALLED=NO
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DREAM_RERUN=NO
```

## Visual Presentation Cleanup

The Visual Memory presentation cleanup keeps attachment ownership in the
visual event semantics: the owner message owns the first current image,
`media_ref` owns recalled/previous/revisit inspection images, and activity rows
remain text-only. Legacy activity rows that already contain attachment
metadata are also rendered without an image. Visual activity copy is projected
to short natural-language labels, while the stored observation/evidence path
remains intact.

```text
FINAL_STATUS=READY_FOR_PRODUCTION_DEPLOYMENT
BASE_COMMIT=b3b2cce09fd463fcc09e77444843da6ace16a54c
BRANCH=feat/visual-presentation-cleanup
COMMIT=RECORDED_IN_GIT
REMOTE_HEAD=PUSHED_TO_ORIGIN
WORKTREE=CLEAN_AFTER_COMMIT
ROOT_CAUSE_DUPLICATE_IMAGE=ACTIVITY_SOURCE_ATTACHMENT_AUTOMATICALLY_RENDERED
IMAGE_RENDER_OWNER=USER_DIALOGUE_FIRST_CURRENT_MEDIA_REF_RECALLED_PREVIOUS_REVISIT
LONG_TERM_ATTACHMENT_VISIBLE_COUNT=1
ORIGINAL_IMAGE_REOPEN=PASS
LOCAL_BRAIN_REINSPECTION=PASS
LONG_TERM_VISIBLE_ACTIVITY_STEPS=2
FULL_OBSERVATION_VISIBLE=NO
FULL_OBSERVATION_PERSISTED=YES
LONG_TERM_FINAL_DEFAULT_BUBBLES=1
LONG_TERM_FINAL_MAX_BUBBLES=2
CURRENT_IMAGE_DUPLICATE_RENDER=NO
MULTI_VISUAL_DISTINCT_IMAGES=PASS
A_B_A_REVISIT=PASS
TIMESTAMP_METADATA_LEAK_FIXED=PASS
LONG_TERM_RECALL_REGRESSION=PASS
RECENT_VISUAL_REGRESSION=PASS
MULTI_VISUAL_REGRESSION=PASS
FIVE_INSPECTION_CAP=PASS
VISUAL_MEMORY_CORE_MODIFIED=NO
RETRIEVAL_MODIFIED=NO
PRODUCTION_DATA_MODIFIED=NO
PRODUCTION_DEPLOYED=NO
```

## 2026-09-14 — Memory Pipeline v2 最终审计 / 硬化 / 生产发布

Status: `FINAL_STATUS=MEMORY_PIPELINE_V2_LIVE_IN_PRODUCTION`

用户下达生产发布任务：完成最终源码审计 → 修复必要 bug → 完整 regression → commit → push
→ 推入当前 production → 必要时自动 rollback。用户同时冻结了全部设计选择（八条 blocker、
24h 跨度、30min 会话间隔、8min/20min 睡眠连续性、seed 排除、确定性摘要、关键词接地、
final request guard、schema 版本化、回填工具），并要求**不要再询问设计选择**。

### 最终上线版本

```text
FEATURE_BRANCH      feat/life-experience-buffer
FEATURE_HEAD        8312ce66cd65700450305185246c31edcc28b1d9   （已推 origin）
PRODUCTION_HEAD     8312ce66cd65700450305185246c31edcc28b1d9   （ff-only，无 merge commit）
DEPLOY_BASE         4a3b8ef91d6fa806616a4b29825405b8fe02d938
COMMITS             a4cab9d  feat(memory): harden Memory Pipeline v2 for production
                    8312ce6  test(memory): pin the scheduled reflection lifecycle
DELTA               63 个文件；android-companion/** 命中 0
```

### 八条 blocker 的落地

```text
A  Consolidator 提交路径改走 MemoryGate，gate 缺失即 fail-closed；
   并在 pet-runtime.js 真实注入 memoryGate（此前 gate 存在但从未接线）。
A1 提交循环整趟原子：抛错时用 PetMemory.forget() 回滚本趟已写入的行，
   「报告失败」与「确实没写」不再互相矛盾。
B  tick 与手动共用同一套 reflection 生命周期：先 flush → 冻结 pending 快照 →
   用该视图跑引擎 → 仅在 completed 后消费该快照。
B1 Consolidation 只消费它真的做出判断的行（稳定候选组、或凭证文本被主动清除）；
   没有稳定模式的日常对话留在 buffer 给 Reflection（此前一个 tick 会吞掉整批）。
C  Dream 与 Reflection 拆开可见性：Reflection 只看 pending，Dream 看近期生活含已整理。
D  formatConversationEvidenceBoundary() 改为常量大小声明，system prompt 不再逐条复制
   source map。三个口径必须分开讲（细节见 docs/DEVLOG_MEMORY_PIPELINE_V2.md 附录 A.9/A.10）：

   (a) 自造夹具，基线 vs 发布版，同一脚本：
         turns  systemChars      SYSTEM_TOKENS    RECENT_MESSAGE_N_LINES
         12     5091 → 3581      1970 → 1436      24 → 0
         24     7023 → 3581      2594 → 1436      48 → 0
         50    11210 → 3581      3947 → 1436     100 → 0
   (b) 生产真实内容（真实 rules/soul/fact + 真实 buildPetMessages）：
         turns 12/24/50 全部 3915 字符 / 1616 tokens / RECENT_MESSAGE_N_LINES=0
         —— 这是下界，未含 brain 追加的 MEMORY/BELIEF 指令块
   (c) 独立验收实测含指令块：4092 字符 / 1755 tokens
   最坏 50 turns 总 tokens 16742（超 16384）→ 14231。

   决定性证据：contextTurns 12→50 对 system 规模影响为 0（3229/1255 三档全同），
   userText 长度影响也为 0；system 只随 memories/currentSelf/stableRules 的真实内容量
   变化（实测区间 3053–3531 字符），不随轮数增长。
D2 planFinalRequestBudget() 按 LOW→MEDIUM→HIGH 从最旧开始裁轮，保护最新 6 轮，
   宁可拒发也不溢出；实测估算对真实分词器有 1.2x–2.3x 余量。
E  关键词必须接地：全部不接地的候选直接拒绝（keywords-ungrounded），交回 gate 的
   owner 原话兜底；模型声明 keywords: [] 时仍接受（显式 owner 路径没有关键词来源）。
F  图片 observation 只作为 Dream 背景，永不进入 source_ids，不增加 evidenceCount，
   不提高 confidence。
G  对外 dream summary 由真正落库的 derived rows 确定性生成，模型散文留在
   changes.modelSummary。生产 dream_log id=15 已见 understandingCount=0 与
   evidence:"inferred" 的真实样本。
H  seed 行使用独立 source session；两条遗留 bootstrap 行从 Dream/Reflection 来源排除，
   但不改写、不删除。
```

### 独立只读审计发现并修复的 6 条缺陷

```text
A1/B1/E1/3A/3B/B3/B4  详见 docs/DEVLOG_MEMORY_PIPELINE_V2.md 附录 A.7
其中最关键的一条（审计 B DEFECT 1）：
  实测 beforePending=10 helperSnapshot=none afterPending=0 reflectionLast=null
  ——「一次什么都没找到的 consolidation 把 10 条 pending 全部吃掉，Reflection 连跑都
  没轮到」。
```

### 发布前验证（feature worktree，代码冻结）

```text
单测矩阵        29/29  EXIT=0
npm 测试矩阵    11/11  NPM_EXIT=0 + 新增 test:reflection-scheduler
生产库彩排      34/34  REHEARSAL_PASS=34 REHEARSAL_FAIL=0
真实大脑 live    v0.4-context-safety-live / v0.4-image-memory-live /
                v0.4-dream-live-quality 全部 EXIT=0
```

### 生产数据操作与不变量

```text
迁移         experience-buffer.sqlite 由无到有：18 列 / meta.schema_version=2 /
             mode=0600 / ROWS=0；dry-run 不落盘已核对
回填         SCANNED_USER_MESSAGES=164 → EXPLICIT_CANDIDATES=4 → WOULD_WRITE=3 /
             DUPLICATES=1；--apply 后 fact 220→223、provenance 144→147；
             第二次 --apply WOULD_WRITE=0（幂等）；archive SHA256 前后一致
黑莓验收     回填前真实事实对四个查询全部不在 top-5；回填后
             「猫猫叫什么名字」#2、「黑莓叫什么」#4、「黑莓长什么样」#4、
             「我们家猫叫什么」#1，ABSENT_FROM_TOP_K=[]
未动         conversation-archive.db（472 行 / max_sequence 10669）
             visual-experience.db（46/47/54/5027）
             PetMemory 原有 220 条 fact、14 条 dream_log 逐条复核未丢
生产 dirty   22 项全部在 android-companion/**，部署前后逐字节 SHA256 比对一致
```

### 部署过程

```text
1. 备份：分支 backup/life-experience-pre-production-* 与
   backup/production-pre-memory-v2-*；回填前再备份到
   ~/.local/share/vc-ai-pet/backups/pre-backfill-apply-20260914-215143/
   （raw + VACUUM INTO logical + sha256.txt）
2. git merge --ff-only（两次：a4cab9d、8312ce6），无 merge commit
3. DSH Web 重启：旧 PID 522122 → 新 PID 1983032（22:44:37 启动，
   晚于 21:52 的代码合入），3080 与 17870 均在新进程上
4. 复活验证：GET /api/pet/state 与 GET /api/inner-life 均 200；
   世界状态文件在重启后被写入；experience-buffer.sqlite 在进程内被创建
```

### 已知遗留（本轮明确未做，不隐藏）

```text
1. 生产 PetMemory 里那条被污染的 lesson「主人说：一定要记住哦」
   （keywords=猫猫,名字,黑莓）在部分黑莓查询里仍占 rank 1。
   本轮没有加 reranker —— 它确实把真实事实压到 #2/#4，但真实事实已在 top-5 内可见。
   根治需要 reranker 或给被污染行清关键词，属于下一轮。
2. 回填写入的 3 条 fact 的 keywords 为空数组（highPriorityMemoryCandidate() 不产生
   关键词）。它们靠 BM25 正文匹配与 importance=3 被召回，不靠关键词索引。
3. contextWindow 三处不一致：settings.yaml 声明 131072、本地大脑实际
   `-ContextSize 32768`（LOCAL_BRAIN_MODELS_N_CTX=32768 实测）、guard 保守按 16384
   规划。未修改模型启动参数（用户明令禁止）。因此真实余量比文档估计更大：最坏
   50 turns 14231 tokens 相对 32768 仍有 56.6% 余量。
4. 测量口径：`POST /tokenize` 入参字段名是 `content`，传 text/prompt/input 会返回空
   tokens。本轮所有 token 数字都出自 content 字段（TOKENIZER=LOCAL_BRAIN_QWEN_TOKENIZE）。
```
#### 口径陷阱（同轮发现，务必不要误用）

`handoffs/measure-system-prompt.mjs` 在**基线 `db8e8e5`** 上跑得出
`systemChars=5091`（12 turns，`RECENT_MESSAGE_N_LINES=24`）→ `11210`（50 turns，
`RECENT_MESSAGE_N_LINES=100`），线性增长；在**发布版**上跑得出恒定的
`3581 / RECENT_MESSAGE_N_LINES=0`。这组对照是有效的（同一脚本、同一分词器）。

但若把那个脚本的 fixture 换成生产真实内容（真实 rules / soul / fact）再同时跑
基线与发布版，两边**都会**得到恒定值（基线 3509、发布版 3915，`RECENT_MESSAGE_N_LINES`
都为 0）。原因是该路径下基线也没有逐条复制 source map —— 说明**基线的膨胀只在特定
输入路径上出现**，而这些路径恰好就是脚本默认 fixture 覆盖的那些。

因此正确的表述是：**默认 fixture 口径**下基线线性膨胀、发布版恒定；
**真实内容口径**下两者都恒定，但发布版的常量比基线高 406 字符（相同内容下这是
boundary 声明的固定成本差异，不是膨胀）。判断「是否与 turns 解耦」必须看
`contextTurns` 的敏感性（发布版 12/24/50 全部 3229/1255，影响为 0），
不能只看两个常量是否相等。

## 2026-09-29：看图后的普通提问误触发历史找图

只读检查本机 conversation archive 后确认：一轮没有附图、询问花花回答口吻的普通提问，因为包含“图片”被送入最近图片召回；候选之间仅有一个常见汉字重合，旧逻辑仍将纸箱中的猫图当作唯一匹配并发出。视觉分支随后直接发布模型生成的回复，未使用普通聊天的人格口吻规则。此前另一轮在上传早餐图后插入了新的文字话题，“这张图”仍被宽松的“最近两条用户消息有图”规则绑定到旧上传图。

本轮收紧最近视觉入口：单纯提到图片不再触发回看；明确回看、找图、图内内容和比较仍可进入视觉流程。即时指代只绑定紧接着的上一条用户图片消息；隔着新的文字话题而无法确认是哪张图时澄清。语义找图需要足够具体的画面描述；先用图库已有的 256 像素预览图由本地视觉模型筛候选，再逐张重看原图。只有恰好一张原图与主体、物体和场景关系吻合时才发送；多张都像或全不吻合时请求补充特征。重复上传归为同一视觉经历，找回时选最近一次上传。主人确认过的宠物称呼只用于解释名字，不能替代原图核验。普通聊天和交互式视觉回复共用简短的李花花小狗口吻规则；后台记忆整理仍只做观察。

回归验证：`test/v0.3-recent-visual-recall.mjs`、`test/v0.3-turn-orchestrator.mjs` 均通过，覆盖普通提问不发旧图、单字不选图、明确找图、当前图、前一张和比较。项目自带爪印测试图实际调用本地视觉模型，返回合法 JSON 和小狗口吻回复。真实手机端对话效果仍由主人验收。

追加真实图库只读验证：当前 54 个视觉经历、56 次上传；笑脸吐司的两次上传是同一张照片，按视觉经历合并后以最近一次上传作为找回目标。54 张既有 256 像素预览的全图库筛选约需 55 秒，最终仍逐张检查原图。四张真实照片（纸箱里的黑莓、凳子上的猫、笑脸吐司加寿司、另一份三明治）的定点题覆盖了正例、相似错图和不存在的描述；误图不发送。128 像素临时预览的两道正例和一道不存在的负例也正确，但没有足够证据表明全图库改成 128 像素会更快且不损失细节，因此生产继续使用已有 256 像素缩略图。实测还暴露本地模型偶尔把 `{"visualIds":[0]}` 作为数组内的字符串返回；现仅对这种已观察到的格式解包，再按合法 V 编号校验。主人原图与手机端最终发送行为待人工验收。
