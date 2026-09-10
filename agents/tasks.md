13. Task Prompt Library — حالات التشغيل
البرومنتات التالية تُستخدم بعد Global Guardrails + System Prompt الخاص بالAgent.
13.1 إنشاء تقويم محتوى شهري
Agent المسؤول: Content Strategy
TASK: MONTHLY CONTENT CALENDAR
أنشئ تقويم محتوى لمدة {{days_count}} يومًا لـHyperCool.
المدخلات:
campaign={{campaign_context}}
products={{product_catalog}}
stock={{stock_data}}
metrics={{metrics}}

المطلوب:
- لا تكرر نفس الزاوية خلال 10 أيام إلا لسبب.
- وزّع funnel stages.
- أعطِ أولوية للمنتجات المتاحة والمناسبة للموسم.
- LinkedIn ثلاث مرات أسبوعيًا B2B.
- لكل يوم: platform, audience, objective, pillar, product, hook_angle, CTA,
  asset_needed, evidence_needed, priority, approval_risk.
- علّم أي خانة تحتاج بيانات بـNEEDS_DATA.

13.2 كتابة Instagram Post
Agent المسؤول: Copywriting
TASK: INSTAGRAM POST
حوّل الفكرة التالية إلى منشور Instagram:
{{content_brief}}
استخدم فقط الحقائق المعتمدة.
أخرج:
hook_ar, caption_ar, CTA_ar, hook_en, caption_en, CTA_en,
hashtags, URL, factual_dependencies, compliance_flags.
اجعل العربية طبيعية سعودية، قصيرة نسبيًا، وبدون مبالغة طبية.

13.3 كتابة LinkedIn B2B
Agent المسؤول: Copywriting
TASK: LINKEDIN B2B POST
الجمهور={{b2b_segment}}
الهدف={{objective}}
الموضوع={{topic}}
المنتج/الحل={{product_context}}

اكتب Post يهم مالك المنشأة أو التشغيل أو المشتريات.
الهيكل:
1) Business problem.
2) Insight.
3) How HyperCool fits.
4) Proof/fact if verified.
5) CTA مهني.
لا تستخدم نبرة Instagram ولا هاشتاقات كثيرة.

13.4 Reel Script
Agent المسؤول: Creative
TASK: REEL SCRIPT
حوّل {{approved_copy}} إلى Reel مدته {{duration_seconds}} ثانية.
أخرج Timeline بالثواني:
scene, visual, camera/action, on_screen_text, VO, subtitle, product_focus, CTA.
إذا أصل بصري غير متوفر => ASSET_REQUIRED.
لا تضف أي claim جديد.

13.5 فحص محتوى قبل النشر
Agent المسؤول: Compliance
TASK: PRE-PUBLISH COMPLIANCE CHECK
راجع:
copy={{final_copy}}
asset_text={{asset_text}}
product={{product_context}}
price={{price_context}}
stock={{stock_context}}
claims={{approved_claims}}
URL={{landing_url}}

تحقق بندًا بندًا.
أخرج classification=PASS/PASS_WITH_EDITS/BLOCK.
لكل issue: severity, exact_text, problem, corrected_version, evidence_required.

13.6 معالجة فشل النشر
Agent المسؤول: Publishing
TASK: PUBLISH FAILURE RECOVERY
حدث الخطأ التالي:
{{api_error}}
idempotency_key={{idempotency_key}}
last_known_status={{last_status}}

قرر بالترتيب:
1) هل يمكن أن يكون النشر تم رغم timeout؟
2) هل توجد وسيلة للتحقق من post_id؟
3) هل retry آمن؟
4) هل نحتاج HUMAN_REVIEW؟
ممنوع retry إذا قد ينتج duplicate.

13.7 Lead B2B جديد
Agent المسؤول: Lead Generation
TASK: QUALIFY B2B LEAD
المصدر={{source_data}}
قيّم الجهة كفرصة HyperCool.
لا تقبل Lead بدون fit rationale أو trigger.
أخرج:
company, segment, city, trigger, trigger_date, source_url,
fit_score_1_to_5, likely_need, decision_role, route_in,
recommended_offer, next_action, confidence.

13.8 أول رسالة واردة B2C
Agent المسؤول: Sales
TASK: FIRST INBOUND B2C MESSAGE
رسالة العميل:
{{customer_message}}
السياق:
{{customer_context}}

افهم intent أولًا.
إذا المنتج واضح جاوب مباشرة ثم اسأل سؤال تأهيل واحد فقط.
إذا غير واضح اسأل أقصر سؤال يحدد الاحتياج.
لا تطلب الميزانية إلا إذا مفيدة فعلًا.
أخرج reply_ar + crm_updates + next_best_action.

13.9 أول رسالة واردة B2B
Agent المسؤول: Sales
TASK: FIRST INBOUND B2B MESSAGE
رسالة العميل={{customer_message}}
إذا تبين أنه منشأة:
اجمع تدريجيًا facility_type, city, intended_use, quantity, timeline.
لا تسأل كل شيء دفعة واحدة.
إذا ذكر كمية/مشروع/موعد قريب => lead_temperature=HOT.
اقترح Quote أو اتصال عندما تصبح المعلومات كافية.

13.10 سؤال عن السعر
Agent المسؤول: Sales
TASK: PRICE QUESTION
العميل يسأل عن السعر لمنتج={{product_name}}.
تحقق من {{price_list}} أولًا.
إذا VERIFIED: اذكر السعر بوضوح + ما الذي يشمله إن كان موثقًا + CTA.
إذا غير متحقق: لا تعطي رقمًا؛ أعد NEEDS_DATA.
إذا B2B quantity>1 اقترح عرض سعر دون اختراع خصم.

13.11 طلب خصم
Agent المسؤول: Sales
TASK: DISCOUNT REQUEST
العميل طلب خصم.
current_price={{verified_price}}
allowed_band={{approved_discount_band}}
customer_context={{customer_context}}

إذا الخصم المطلوب داخل النطاق والمستوى يسمح: استخدم الحد المسموح فقط.
إذا خارج النطاق: لا تفاوض من نفسك؛ HUMAN_HANDOFF.
أعطِ ردًا يحافظ على قيمة المنتج ولا يبدو رفضًا جافًا.

13.12 المنتج غير متوفر
Agent المسؤول: Sales
TASK: OUT OF STOCK
product={{product_name}}
stock={{stock_data}}
alternatives={{product_catalog}}

إذا المخزون مؤكد صفر:
- كن واضحًا.
- لا تعطِ موعد restock غير موثق.
- اقترح أقرب بديل فقط إذا مناسب فعلاً.
- اعرض تسجيل اهتمام للمتابعة إذا العميل وافق.

13.13 سؤال طبي/صحي
Agent المسؤول: Sales
TASK: MEDICAL OR HEALTH QUESTION
customer_message={{customer_message}}
approved_claims={{approved_claims}}

لا تشخص ولا تعد بنتيجة علاجية.
يمكنك ذكر المعلومات المعتمدة فقط.
إذا السؤال يتطلب تفسير طبي أو حالة شخصية => HUMAN_HANDOFF / recommend professional consultation.
أخرج ردًا مفيدًا ومحايدًا بدون تخويف.

13.14 اعتراض: السعر مرتفع
Agent المسؤول: Sales
TASK: OBJECTION — PRICE TOO HIGH
استخرج سبب الاعتراض الحقيقي من السياق إن أمكن.
لا تقدم خصم مباشرة.
استخدم value framing موثقًا: build quality / service / warranty / use-case / total value فقط إذا موجود بالبيانات.
اختم بسؤال بسيط يحدد ما إذا كان العائق ميزانية أم مقارنة أم توقيت.

13.15 طلب عرض سعر رسمي
Agent المسؤول: Sales
TASK: QUOTE INTAKE
اجمع فقط البيانات الناقصة لإصدار Quote:
company_name, contact_name, city, product, quantity, delivery_requirement,
VAT_or_company_fields_if_required, timeline.
لا تعيد سؤال بيانات موجودة.
عند اكتمال الحد الأدنى:
next_best_action=CREATE_QUOTE
وأخرج quote_payload منظم.

13.16 Hot Lead Handoff
Agent المسؤول: Sales
TASK: HOT LEAD HANDOFF
كوّن Brief لموظف المبيعات في أقل من 8 أسطر:
who, company, need, product, quantity, city, timeline, budget_if_known,
objections, last_customer_message, recommended_next_action.
كوّن أيضًا رسالة قصيرة للعميل تؤكد أن المختص سيتابع معه بدون وعد بوقت غير موثق.

13.17 شكوى عميل غاضب
Agent المسؤول: Sales
TASK: ANGRY CUSTOMER
اعترف بالمشكلة بدون اعتراف قانوني بالمسؤولية.
لا تجادل.
استخرج order_id أو وسيلة التحقق إذا غير موجودة.
أي تهديد قانوني/سلامة/إصابة/مشكلة صحية => HUMAN_REVIEW فوري.
لا تعد بتعويض أو استرجاع إلا حسب policy الموثقة.

13.18 Follow-up بعد Quote — Touch 1
Agent المسؤول: Follow-up
TASK: QUOTE FOLLOW-UP TOUCH 1
أرسل بعد المدة المعتمدة فقط.
الهدف: التأكد من الاستلام + إزالة عائق واحد.
لا تقل "مجرد تذكير".
اسأل سؤالًا قصيرًا: هل تحتاج توضيحًا على المواصفات/التوصيل/الكمية؟

13.19 Follow-up بعد Quote — Touch 2
Agent المسؤول: Follow-up
TASK: QUOTE FOLLOW-UP TOUCH 2
استخدم سياق الاعتراض إن وجد.
أضف قيمة جديدة: مقارنة مناسبة، FAQ، أو توضيح عملية الشراء.
CTA واحد فقط.
إذا رد العميل منذ Touch1 => HOLD.

13.20 Follow-up بعد Quote — Final
Agent المسؤول: Follow-up
TASK: QUOTE FOLLOW-UP FINAL
رسالة أخيرة محترمة غير ضاغطة.
اعرض إبقاء العرض/الملف مفتوحًا أو إغلاق المتابعة مؤقتًا.
إذا لا رد بعد هذا touch => PARKED مع next_check_date.

13.21 Cart Recovery
Agent المسؤول: Follow-up
TASK: CART RECOVERY
استخدم فقط إذا توجد موافقة تواصل والبيانات تسمح.
لا تدّعِ أن المنتج "سيخلص" إلا إذا المخزون يدعم ذلك.
ذكّر بالفائدة/المنتج + رابط السلة أو المنتج الصحيح + مساعدة إذا واجه مشكلة.

13.22 Post-Purchase Upsell
Agent المسؤول: Follow-up
TASK: POST-PURCHASE UPSELL
order={{order_context}}
اعرض فقط accessories أو complementary products المرتبطة فعلاً بالمشتريات.
لا تجعل الرسالة مباشرة بعد الشراء بشكل مزعج؛ احترم cooldown.
اربط الاقتراح بسبب استخدام واضح.

13.23 Dormant Lead Reactivation
Agent المسؤول: Follow-up
TASK: DORMANT LEAD REACTIVATION
lead={{crm_record}}
لا تبدأ بـ"لماذا لم ترد".
استخدم Trigger جديد حقيقي: منتج جديد/معلومة/عرض معتمد/موسم/تغيير مهم.
إذا لا يوجد سبب جديد حقيقي => HOLD بدل إرسال رسالة ضعيفة.

13.24 Competitor Sweep
Agent المسؤول: Intelligence
TASK: COMPETITOR SWEEP
observations={{tool_results}}
لكل competitor:
what_changed, date, source, fact, inference, confidence, impact,
content_response, sales_response.
لا تعتبر إعلان المنافس دليلاً على فعالية منتجه.

13.25 تقرير أداء يومي
Agent المسؤول: Performance
TASK: DAILY PERFORMANCE REVIEW
metrics={{metrics}}
قارن بالأمس وبمتوسط آخر 7 أيام إذا متاح.
استخرج anomalies, hot leads, content winner, funnel issue, urgent action.
لا تملأ التقرير بأرقام بلا قرار.

13.26 تقرير أسبوعي للإدارة
Agent المسؤول: Frost
TASK: WEEKLY EXECUTIVE REVIEW
اجمع نتائج جميع Agents للأسبوع.
أخرج صفحة تنفيذية:
1) Revenue/Pipeline.
2) What worked.
3) What failed.
4) Customer signals.
5) Competitor signals.
6) Risks.
7) 3 decisions needed.
8) Top 5 actions next week.
9) Experiments.
10) Items to stop.

13.27 Approval Package يومي
Agent المسؤول: Frost
TASK: DAILY APPROVAL PACKAGE
اجمع فقط العناصر التي تحتاج قرارًا بشريًا.
رتبها P0 ثم P1 ثم revenue impact.
لكل item:
type, summary, why_now, proposed_action, alternatives, risk, deadline,
approve_edit_reject options.
الهدف أن يتمكن المالك من اتخاذ القرارات بسرعة.

13.28 تحديث Memory
Agent المسؤول: Memory
TASK: END-OF-DAY MEMORY REVIEW
candidates={{daily_events}}
لكل candidate:
هل هو fact ثابت؟ rule approved؟ repeated pattern؟ مجرد inference؟
ADD فقط إذا تنطبق eligibility.
أي price/claim/policy update مهم => requires_human_approval=true.

13.29 Tool Result Conflict
Agent المسؤول: Any Agent
TASK: DATA CONFLICT
هناك تعارض:
source_A={{source_a}}
source_B={{source_b}}
لا تختَر أحدهما عشوائيًا.
حدد freshness, authority, scope.
إذا لا يمكن حسم التعارض => HUMAN_REVIEW وامنع أي Action يعتمد على الحقل المتعارض.

13.30 Missing Data Recovery
Agent المسؤول: Any Agent
TASK: MISSING DATA RECOVERY
المهمة الحالية لا يمكن إكمالها بسبب بيانات ناقصة.
حدد أقل مجموعة بيانات لازمة فقط.
أخرج:
missing_fields, why_needed, preferred_tool_or_source, safe_partial_action,
blocked_action.
لا تسأل العميل سؤالًا يمكن الحصول على إجابته من Tool داخلي.
