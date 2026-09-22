# محرك الوكلاء (Agent Runtime)

مرجع فني لما بُني فعليًا تحت `src/runtime/`. هذا ليس "12 شاتبوت بأسماء مختلفة" — كل وكيل يمر من نفس المحرك الموحد ويختلف فقط في: البرومبت (`agents/*.md`)، مخطط المخرجات (`src/payload-schemas.js`)، مستوى صلاحيته الحالي (`agent_autonomy`، مبني مسبقًا)، وأي أدوات يطلبها فعليًا.

## البنية

| الوحدة المطلوبة | الملف الفعلي | ملاحظة إعادة الاستخدام |
|---|---|---|
| AgentRegistry | `src/runtime/registry.js` | جدول `agent_registry` رقيق فقط (enabled/provider/model)؛ البرومبت يبقى في `agents/*.md` والمخطط في `payload-schemas.js` — لا نسخ مكرر |
| AgentExecutionService | `src/runtime/runtime.js` | `createAgentRuntime().run(agentId, {...})` — المُشغّل الوحيد لكل الوكلاء الاثني عشر |
| AgentToolRegistry | `src/runtime/tools.js` | كل أداة: `{name, inputSchema, minLevel, integration, handler}` |
| AgentPermissionService | `src/runtime/permissions.js` | يبني فوق `src/autonomy.js` الموجود مسبقًا (لا يستبدله) |
| AgentEventBus | `src/runtime/events.js` | `EventEmitter` + جدول `agent_events` للتدقيق |
| AgentOrchestrator (Frost) | `src/runtime/orchestrator.js` | يوجّه الأحداث لوكيل واحد أو أكثر |
| AgentApprovalService | `src/runtime/approvals.js` | جدول `agent_approvals` — **فقط** للإجراءات التي لم يكن لها بوابة بشرية أصلًا (خصم، عرض كبير، تغيير ذاكرة، ادعاء طبي، تغيير صلاحية) |
| AgentEscalationService | `src/runtime/escalations.js` | جدول `agent_escalations` — يخدم أيضًا كـ"Task/Notification" لعدم وجود جدول مهام منفصل في المشروع أصلًا |
| LLMProvider | `src/runtime/llmProvider.js` | Anthropic فقط اليوم؛ حلقة tool-use حقيقية متعددة الأدوار مع محاولة إصلاح بنيوي واحدة |
| AgentContextBuilder | داخل كل استدعاء أداة | لا يُبنى سياق ضخم مسبقًا؛ الوكيل يطلب الأداة وقت الحاجة (مطابق لسيناريو 1 في الطلب) |
| AgentOutputValidator | `src/agents.js` (موجود، مُعاد استخدامه) | `validateAgentDecision` + قاعدة BLOCK⇒status=BLOCKED الموجودة أصلًا |
| AgentScheduler | `src/runtime/scheduler.js` | حلقة `setInterval` داخل نفس عملية Node (لا يوجد cron خارجي بعد) — تعمل فقط عند `npm start`، لا تعمل تلقائيًا داخل الاختبارات |
| AgentEscalationService (كصمام إيقاف) | `src/runtime/gate.js` | `runtime_gate` — إيقاف/استئناف كل الإجراءات المستقلة (الجدولة + الأحداث)، لا يوقف التشغيل اليدوي (زر «اختبار الوكيل») |

## الأدوات (Tool Registry)

قراءة فقط (L0، بلا أي كتابة): `get_products`, `get_product`, `get_current_price`, `get_stock`, `search_crm`, `get_lead`, `get_conversation`, `search_brand_memory`, `get_competitor_data`, `get_metrics`.

مسودة/اقتراح (L0 — لا تُعد "إجراءً خارجيًا"، تُنشئ سجلًا معلّقًا للمراجعة البشرية بالضبط كما لو كتبه مشغّل بشري): `create_lead`, `update_lead`, `save_message`, `create_followup`, `create_content` (يُنشأ بحالة DRAFT دائمًا)، `propose_memory_update` (لا يكتب الذاكرة مباشرة — ينشئ طلب موافقة `memory_policy_change`).

إجراءات خارجية (L1/L2 وتحتاج تكامل متصل، وإلا `INTEGRATION_REQUIRED` دائمًا بصرف النظر عن المستوى): `whatsapp_send`, `meta_publish`, `x_publish`, `linkedin_publish`, `microsoft_sendEmail`, `generate_visual_asset`, `salla_syncOrders`.

أسماء الأدوات تستخدم `_` لا `.` لأن Anthropic تشترط `^[a-zA-Z0-9_-]{1,128}$` لاسم الأداة.

## قاعدة الصلاحية الفعلية

`src/runtime/permissions.js`: `canUseTool(level, tool)` تُستدعى داخل كل تنفيذ أداة (`runtime.js`)، وليست مجرد شارة واجهة. حتى لو "أراد" النموذج استدعاء أداة غير مسموحة لمستواه، ينفَّذ الرفض على مستوى الخادم قبل تنفيذ أي كود حقيقي، ويُسجَّل كـ`FORBIDDEN` في `agent_tool_calls`.

## قاعدة الـ14 يومًا

`promotionEligibility(db, agentId)` تحسب فعليًا من `agent_runs` و`agent_escalations` و`agent_autonomy`: صفر تشغيلات فاشلة، صفر حظر امتثال، صفر حوادث حرجة (P0)، و14 يومًا مرّت منذ آخر تغيير مستوى (أو منذ أول تشغيلة إن لم يتغير المستوى إطلاقًا). النتيجة `ELIGIBLE_FOR_PROMOTION` أو `NOT_ELIGIBLE` فقط — **لا ترقية تلقائية بأي حال**؛ الترقية تبقى حصرًا عبر `POST /api/agents/:id/autonomy` بواسطة المالك.

## الأحداث المفعّلة فعليًا اليوم

من بين عشرين حدثًا معرّفة في `EVENT_TYPES`، المفعّل والمربوط بمسار حقيقي حاليًا:

- `CUSTOMER_MESSAGE_RECEIVED` — يُطلق تلقائيًا من `POST /api/crm/leads/:id/messages` عند تسجيل رسالة واردة جديدة، ويوجَّه لوكيل `sales`.
- `LEAD_CREATED` — يُطلق من `POST /api/crm/leads` (مسجَّل، غير موجَّه لوكيل بعد).
- `CONTENT_APPROVED` — يُطلق بعد اعتماد المالك للمحتوى (مسجَّل، غير موجَّه لوكيل بعد — لا يوجد موصل نشر فعلي).
- `AGENT_RUN_FAILED` — يُطلق تلقائيًا من داخل المحرك نفسه عند أي فشل تشغيلة أو معالج حدث.

باقي الأحداث (`QUOTE_REQUESTED`, `CONTENT_IDEA_CREATED`, إلخ) معرّفة في `orchestrator.js` كمسارات جاهزة لكن لا مصدر حقيقي يُطلقها بعد.

## التشغيل الذاتي المستمر (AgentScheduler)

عند `npm start`، الجدولة تعمل فعليًا بلا أي تدخل بشري:
- **08:00 بتوقيت الرياض يوميًا**: حفظ حزمة اليوم (`saveDailyBrief`) — نفس الدالة التي تستدعيها نقطة نهاية المحفز الخارجي الاختيارية (`/api/automation/daily-brief`) عند استخدامها.
- **الأحد**: حفظ التقرير الأسبوعي (`saveWeeklyReport`).
- **كل دورة (كل 5 دقائق افتراضيًا، `SCHEDULER_INTERVAL_MS`)**: مسح كل عميل بمرحلة `QUOTE_SENT`/`DEMO`/`POST_PURCHASE` بلا سلسلة متابعة نشطة وبلا إيقاف تواصل، وتشغيل وكيل المتابعة عليه فعليًا (`sweepFollowupGaps`) — نفس التحقق من الموافقة والحد اللحظي المستخدم في المسار اليدوي.
- **فوريًا عند الحدث**: عميل جديد (`LEAD_CREATED`) أو رسالة واردة (`CUSTOMER_MESSAGE_RECEIVED`) يشغّلان وكيل المبيعات تلقائيًا بلا انتظار أي زر.

**صمام الإيقاف**: `POST /api/frost/pause` (المالك فقط) يوقف كل هذا فورًا — الجدولة والأحداث معًا — مع تسجيل من أوقفه وسببه؛ `POST /api/frost/resume` يُعيده. التشغيل اليدوي من «اختبار الوكيل» يبقى يعمل دائمًا حتى أثناء الإيقاف، لأنه طلب بشري مباشر لا إجراء مستقل. متاح من واجهة «فريق الوكلاء» مباشرة (غرفة تحكم Frost أعلى الصفحة)، وأيضًا `GET /api/frost/status` و`POST /api/frost/run-now` لتشغيل الدورة فورًا يدويًا.

**مهم جدًا**: التشغيل التلقائي هذا **لا يرسل ولا ينشر أي شيء خارجيًا أبدًا** — كل الوكلاء عند L0 افتراضيًا (لا إجراء خارجي بالتصميم)، وحتى مع ترقية المستوى، كل الأدوات الخارجية (`whatsapp_send`, `meta_publish`...) ترجع `INTEGRATION_REQUIRED` لعدم ربط أي حساب بعد. الأتمتة هنا تعني: **الوكلاء يلاحظون العمل ويصيغون المسودات والتوصيات بأنفسهم باستمرار**، ثم تبقى في طوابير الموافقة والمراجعة البشرية الموجودة أصلًا (مراجعة/اعتماد المحتوى، اعتماد المتابعة) تمامًا كما كانت.

## ما هو منجز فعليًا مقابل ما هو مبني للمستقبل فقط

منجز ومُختبر فعليًا اليوم: تسجيل الوكلاء، تنفيذ حقيقي لوكيل واحد (`sales`) بحلقة أدوات كاملة تصل حتى نموذج Anthropic حقيقي عند توفر مفتاح، إنفاذ صلاحيات، تسجيل تشغيلات وأدوات ومحاولات ممنوعة، تصعيد بشري حقيقي، موافقة عامة حقيقية لتحديثات الذاكرة، وربط حدثي واحد كامل (رسالة عميل ← Frost ← وكيل مبيعات ← رد داخلي بلا إرسال).

مبني كبنية تحتية جاهزة لكن غير مُفعَّل بمنطق أعمال خاص بعد: بقية الوكلاء الأحد عشر تُشغَّل عبر نفس المحرك (يمكن اختبارها الآن من "اختبار الوكيل" في كل بطاقة)، لكن لا يوجد Bootstrap منطق أعمال إضافي مكتوب خصيصًا لكل واحد منها (كل وكيل يعتمد فعليًا على برومبته النصي في `agents/*.md` ليقرر متى يستخدم أي أداة — لم أكتب "حالات عمل" برمجية صريحة كالمطلوبة في قسم SALES CASES مثل "عميل غاضب" أو "مقارنة منافس" كمسارات كود منفصلة؛ هذه سلوكيات يُفترض أن يستنبطها النموذج من البرومبت + الأدوات المتاحة، ولم تُختبر بمحادثات حقيقية بعد مفتاح API فعلي).
