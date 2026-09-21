import http from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createContent,reviewContent,approveContent} from './domain.js';
import {openStore} from './store.js';
import {createAuth,authorize,fail} from './auth.js';
import {agentDefinitions} from './agents.js';
import {installKnowledge,listMemory,saveMemory,proposeMemoryUpdate,listProducts,replaceProducts} from './knowledge.js';
import {connectionStatus,importSalla,ConnectorError,testAnthropicConnection,testOpenAIConnection,testSallaConnection} from './connectors.js';
import {processGenericWebhook} from './connectors/generic-webhook/webhook.js';
import {installDynamicConnectorTables} from './connectors/dynamic/store.js';
import {installDraftOverlayTables} from './connectors/dynamic/draft-store.js';
import {installBulkOperations,previewBulkVersionMigration,bulkMigrateConnections,bulkRollbackOperation,listBulkOperations,getBulkOperation,previewBulkWebhookReprocess,bulkReprocessWebhookEvents} from './connectors/dynamic/bulk-operations.js';
import {listDeadLetterEvents,listPendingRetries} from './connectors/generic-webhook/retry.js';
import {resolveConnectorDynamic} from './connectors/dynamic/registry.js';
import {listCompatibleConnections} from './connectors/dynamic/compatibility.js';
import {
 createDraftConnector,updateDraftConnector,upsertActionForConnector,deleteActionForConnector,
 upsertTriggerForConnector,deleteTriggerForConnector,validateConnectorDraft,publishConnector,
 disableConnector,reactivateConnector,getConnectorDependencies,listConnectorsForBuilder,
 getConnectorForBuilder,getTenantCatalog,cloneConnectorDefinition,exportConnectorDefinition,
 importConnectorDefinition,listConnectorVersions,getVersionDiff,createDraftVersion,discardDraftVersion
} from './connectors/dynamic/builder.js';
import {getConnectionVersionInfo,previewVersionMigration,migrateConnectionVersion,rollbackConnectionVersion} from './connectors/dynamic/connection-versions.js';
import {
 tenantCustomConnectorsEnabled,createTenantConnectorDraft,updateTenantConnectorDraft,
 upsertTenantConnectorAction,deleteTenantConnectorAction,listTenantConnectorActions,
 upsertTenantConnectorTrigger,deleteTenantConnectorTrigger,listTenantConnectorTriggers,
 submitTenantConnectorForReview,listOwnTenantConnectors,listPendingTenantConnectors,reviewTenantConnector
} from './connectors/dynamic/tenant-custom.js';
import {
 getWebhookConsoleView,rotateWebhookUrl,rotateWebhookSecret,sendTestWebhookEvent,
 listFailedWebhookEventsForConnection,getFailedWebhookEventDetail,reprocessFailedWebhookEvent
} from './connectors/generic-webhook/operations.js';
import {buildConnectionHealthView} from './integrations/connection-health-view.js';
import {getConnectionUsage,getConnectorAnalytics} from './runtime/usage-analytics.js';
import {buildAgentConnectionMap,buildToolCompatibilityView} from './runtime/agent-connection-map.js';
import {createGenericAuthorizeUrl,exchangeGenericCodeForTokens,resolveGenericIdentity,genericOAuth2Configured} from './runtime/generic-oauth2.js';
import {randomBytes as cryptoRandomBytes} from 'node:crypto';
import {executeConnectorAction,checkConnectorHealth} from './connectors/core/runtime.js';
import {CANONICAL_CAPABILITIES} from './connectors/core/capability-registry.js';
import {applyMapping,MappingError} from './connectors/core/mapping.js';
import {createGenerator,listAiRuns} from './generation.js';
import {loadEnvFile} from 'node:process';
import {installPlanning,listSlots,listJobs,createCalendar,scheduleContent,cancelJobs,prepareDue,buildBrief,saveDailyBrief,riyadhDate,authorizeAutomation} from './planning.js';
import {installCRM,listLeads,leadDetail,listFollowups,sequences,createLead,updateLead,recordMessage,contactControl,createFollowups,approveFollowup,prepareFollowups,cancelFollowups,searchLeads,getLead,maybeEscalateHotLead,findOrCreateLeadFromChannel,recordChannelMessage,updateMessageStatus,isOptOutText} from './crm.js';
import {buildSalesDashboard} from './sales-dashboard.js';
import {installCompliance,listComplianceChecks,listComplianceChecksSince,createComplianceChecker,latestComplianceByContent} from './compliance.js';
import {buildIntegrationsDashboard} from './integration-ops.js';
import {buildContentWorkspace} from './content-ops.js';
import {buildMemoryWorkspace,computeMemoryUsage} from './memory-ops.js';
import {assertRoleChangeAllowed,assertDeactivationAllowed,buildTeamDashboard,listUsersForTenant,canManageUserFromTenant} from './team-ops.js';
import {installAutonomy,currentAutonomy,setAutonomy,listAutonomyLog} from './autonomy.js';
import {installReporting,buildExecutiveReport,saveWeeklyReport,listWeeklyReports,currentWeekStart} from './reporting.js';
import {buildReportWorkbook,buildReportPdfBuffer} from './reportExport.js';
import {installRegistry,seedRegistry,listAgents as listRegistryAgents,getAgent,setEnabled,setModelConfig} from './runtime/registry.js';
import {installRuntimeTables,createAgentRuntime,listRuns,getRun,listToolCalls,listChildRuns} from './runtime/runtime.js';
import {installEvents,createEventBus,EVENT_TYPES} from './runtime/events.js';
import {installApprovals,listApprovals,decideApproval,createApproval} from './runtime/approvals.js';
import {installEscalations,listEscalations,resolveEscalation} from './runtime/escalations.js';
import {installContextItems,createContextItem,listContextItems,updateContextItem,archiveContextItem,detectContextConflicts,withFreshness} from './runtime/context-items.js';
import {installSuggestions,syncSuggestions,listSuggestions,acceptSuggestion,dismissSuggestion,createTaskFromSuggestion,suggestionWorkflowTemplate} from './runtime/suggestions.js';
import {installCommandChat,createConversation,listConversations,renameConversation,archiveConversation,moveConversation,createProject,listProjects,renameProject,archiveProject,listMessages,sendCommandMessage} from './runtime/command-chat.js';
import {computeCompanyHealth,deriveQuickCommandKeys} from './runtime/command-health.js';
import {installAttachments,createAttachment,getAttachment,listAttachments,pinAttachmentToBrain,readAttachmentTextForChat,ALLOWED_TYPES,MAX_ATTACHMENT_BYTES} from './runtime/attachments.js';
import {installConfigurationHistory,listConfigurationHistory,undoConfigurationChange} from './runtime/configuration-history.js';
import {installRunbooks,listRunbooks,createRunbook,archiveRunbook,getRunbook} from './runtime/runbooks.js';
import {
 installMarketing,listCampaigns,getCampaign,createCampaign,updateCampaign,archiveCampaign,
 saveCampaignStrategy,saveCampaignIntelligence,listCampaignContentItems,getCampaignContentItem,
 createCampaignContentItem,updateCampaignContentItem,buildMarketingOverview,
 CONTENT_CHANNELS,CONTENT_FORMATS,CAMPAIGN_STATUSES,CONTENT_STATUSES,
 saveComplianceResult,saveCreativeBrief,
 createCampaignOrchestrationWorkflow,campaignOrchestrationTriggerContext,
 createMarketingAsset,listMarketingAssets,getMarketingAsset,setMarketingAssetApproval,deleteMarketingAsset
} from './marketing.js';
import {
 installMarketingAnalytics,syncAllMarketingAnalytics,getMarketingAnalyticsSummary,
 recordPerformanceReview,listPerformanceReviews,getPerformanceReview,setPerformanceReviewStatus
} from './marketing-analytics.js';
import {extractSafeCrmUpdates, applySafeCrmUpdates, proposeStageChangeApproval} from './runtime/agent-crm-updates.js';
import {
 installWebsiteWidgets,getOrCreateWidget,updateWidgetConfig,regenerateWidgetId,
 resolveActiveWidgetByPublicId,isOriginAllowed,checkWidgetRateLimit,
 recordWidgetInboundMessage,recordWidgetOutboundReply,listWidgetConversationMessages
} from './runtime/website-widget.js';
import {searchCommands} from './runtime/command-search.js';
import {installWorkflowEngine,installWorkflowEventTriggers,listWorkflows,getWorkflow,getWorkflowWithVersion,createWorkflowDraft,updateWorkflowDraft,activateWorkflow,pauseWorkflow,resumeWorkflow,archiveWorkflow,computeWorkflowReadiness,startWorkflowRun,requestCancelWorkflowRun,resumeWorkflowApproval,listWorkflowRuns,getRunWithSteps,advanceWorkflowRun,WORKFLOW_STEP_TYPES,WORKFLOW_TRIGGER_TYPES,summarizeWorkflowsForCommandCenter} from './runtime/workflow-engine.js';
import {CONDITION_OPERATORS} from './runtime/workflow-conditions.js';
import {installPlatformFrostChat,listPlatformFrostMessages,sendPlatformFrostMessage} from './runtime/platform-frost.js';
import {getAiUsageSummary} from './runtime/ai-usage.js';
import {installOrchestrator,buildDailyBrief} from './runtime/orchestrator.js';
import {integrationStatus,AGENT_INTEGRATIONS} from './runtime/tools.js';
import {providerStatus} from './runtime/llmProvider.js';
import {promotionEligibility} from './runtime/permissions.js';
import {installGate,getGateStatus,setPaused,isPaused} from './runtime/gate.js';
import {createScheduler} from './runtime/scheduler.js';
import {installCredentials,saveCredentials,credentialsConfigured} from './runtime/credentials.js';
import {installTenancy,ensureDefaultTenant,resolveTenantForUser,listTenants,listWorkspacesForUser,activateWorkspaceForUser,listActiveMembers,getMembership,updateMembershipRole,updateMembershipStatus,listSuspendedWorkspacesForUser} from './tenancy.js';
import {installInvitations,createInvitation,listInvitations,resendInvitation,revokeInvitation,previewInvitation,acceptInvitation,roleForValidToken,checkInvitationRateLimit} from './invitations.js';
import {installPartnerProgram} from './partners/index.js';
import {installClientPortal,makeRunGate,makeWorkflowGate,createClientRoutes,isMerchantOnly} from './client/index.js';
import {classifyRoute} from './security/route-policy.js';
import {countDevSeedAccounts} from './security/demo-accounts.js';
import {createPartnerRoutes,PORTAL_PAGES} from './partners/routes.js';
import {attributeRegistration,markReferralQualified} from './partners/referrals.js';
import {partnerContext} from './partners/access.js';
import {installPlatformIdentity,getUserIdentity,requestEmailChange,resendEmailVerification,verifyEmailToken,requestPasswordReset,consumePasswordResetToken,checkForgotPasswordRateLimit,checkEmailVerificationRateLimit,recordPlatformAudit,registerPublicUser,checkSignupRateLimit} from './platform-identity.js';
import {installPlatformMail,platformMailStatus,sendVerificationEmail,sendPasswordResetEmail,sendInvitationEmail,sendSecurityNotice} from './runtime/platform-mail.js';
import {bootstrapWorkspaceForOwner,assertCanSelfCreateWorkspace,selfServicePolicy} from './workspace-provisioning.js';
import {isPlatformAdmin,isPlatformOperator,requirePlatformOperator,requirePlatformAdmin,buildPlatformOverview,listTenantDirectory,getTenantDetail,suspendTenantByPlatform,reactivateTenantByPlatform,extendTrialByPlatform,setCustomConnectorLimitByPlatform,listPlatformDeadLetterWebhooks,listTenantsWithUnhealthyIntegrations} from './platform-admin.js';
import {checkGlobalSignupLimit,checkWorkspaceCreationIpLimit,checkTotalTrialWorkspacesLimit} from './runtime/pilot-limits.js';
import {botProtectionStatus,captchaRequiredFor,verifyBotProtection} from './runtime/bot-protection.js';
import {isTrialActive,getTrialDaysRemaining,countSelfCreatedWorkspaces,getActiveMemberRole} from './tenancy.js';
import {installContent,migrateUnifyContentItems,listContent,listContentFiltered,getContent,getContentOrNull,insertContent,writeContent,isCampaignShaped} from './content.js';
import {installAuditLog,recordAudit,listAuditLog} from './audit.js';
import {createAuthorizeUrl,consumeState,exchangeCodeForTokens,sallaOAuthStatus,disconnectSalla,resolveSallaAccessToken} from './runtime/salla-oauth.js';
import {createZidAuthorizeUrl,exchangeZidCodeForTokens,resolveZidIdentity} from './runtime/zid-oauth.js';
import {installWebhookEvents,listWebhookEvents} from './runtime/webhook-events.js';
import {resolveTenantForWhatsAppPhoneNumberId,resolveTenantForMicrosoftSubscription,resolveTenantForSallaMerchant,resolveTenantForMetaPageId} from './runtime/webhook-tenant-resolver.js';
import {installIntegrationDefinitions,listIntegrationDefinitions,getIntegrationDefinition} from './integrations/definitions.js';
import {installIntegrationConnections,createConnection,listConnections,getConnection,getConnectionOrNull,updateConnection,setDefaultConnection,getDefaultConnection,resolveProviderAccount,disconnectConnection,deleteConnection,getOrCreateWebhookPublicId} from './integrations/connections.js';
import {installCredentialsVault,storeCredential,getCredentialMeta,removeCredential} from './integrations/vault.js';
import {installOAuthStates,createOAuthState,consumeOAuthState} from './integrations/oauth-state.js';
import {migrateLegacyIntegrationCredentials} from './integrations/migration.js';
import {testConnectionHealth} from './integrations/health.js';
import {verifySallaWebhook,processSallaWebhook} from './runtime/salla-webhooks.js';
import {handleVerificationChallenge,verifyMetaSignature,normalizeWhatsAppWebhook,normalizeMetaMessagingWebhook,normalizeMetaCommentWebhook} from './runtime/meta-webhooks.js';
import {metaOAuthConfigured,createMetaAuthorizeUrl,consumeMetaState,exchangeCodeAndResolveAssets,saveMetaConnection,metaOAuthStatus,disconnectMeta,resolveMetaAccessToken,connectedWhatsAppPhoneNumberId} from './runtime/meta-oauth.js';
import {sendWhatsAppMessage,testWhatsAppConnection,syncWhatsAppTemplates,installWhatsAppTemplates,listWhatsAppTemplates,whatsappConfigured,sendWhatsAppCampaign} from './runtime/whatsapp.js';
import {microsoftOAuthConfigured,createMicrosoftAuthorizeUrl,consumeMicrosoftState,exchangeCodeForTokens as exchangeMicrosoftCodeForTokens,resolveConnectedProfile,saveMicrosoftConnection,microsoftOAuthStatus,disconnectMicrosoft,resolveMicrosoftAccessToken} from './runtime/microsoft-oauth.js';
import {testMicrosoftConnection,sendMail,getMessage,createMailSubscription,deleteMailSubscription} from './runtime/microsoft-graph.js';
import {handleValidationHandshake,processMicrosoftNotifications} from './runtime/microsoft-webhooks.js';
import {updateCredentialsMetadata,getCredentialsMeta} from './runtime/credentials.js';
import {xOAuthConfigured,createXAuthorizeUrl,consumeXState,exchangeCodeForTokens as exchangeXCodeForTokens,resolveConnectedProfile as resolveXProfile,saveXConnection,xOAuthStatus,disconnectX} from './runtime/x-oauth.js';
import {testXConnection} from './runtime/x-publishing.js';
import {linkedInOAuthConfigured,createLinkedInAuthorizeUrl,consumeLinkedInState,exchangeCodeForTokens as exchangeLinkedInCodeForTokens,resolveConnectedProfile as resolveLinkedInProfile,resolveAdministeredOrganizations,saveLinkedInConnection,linkedInOAuthStatus,disconnectLinkedIn} from './runtime/linkedin-oauth.js';
import {testLinkedInConnection} from './runtime/linkedin-publishing.js';
import {setWorkspaceAiDefault,setMaxAgentLevel,getTenant} from './tenancy.js';
import {installTenantAgentConfigs,getTenantAgentConfig,updateTenantAgentConfig,listTenantAgentConfigs,seedTenantAgentConfigs} from './runtime/agent-config.js';
import {installToolDefinitions,listToolDefinitions,getToolDefinition} from './runtime/tool-definitions.js';
import {installAgentToolAssignments,listAssignmentsForAgent,upsertAssignment,deleteAssignment,findAssignmentsUsingConnection} from './runtime/tool-assignments.js';
import {evaluateAgentReadiness,evaluateAllToolsReadiness} from './runtime/agent-readiness.js';
import {buildControlCenterSummary} from './runtime/control-center.js';
import {installOnboarding,getOnboardingState,updateOnboardingState,applyRecommendedPreset,safetySnapshot} from './onboarding.js';
import {connectionGrantsCapability} from './runtime/capability-map.js';
import {levels as autonomyLevels} from './autonomy.js';

const packageVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
// Environment validation — logged at startup, never crashes the process. Every core config
// value (DATA_DIR/PORT/HOST) already has a safe default, so nothing here is required for
// the app to start; this only reports which OPTIONAL integrations aren't configured yet, so
// an operator sees exactly what won't work instead of a vague crash or a silently-fake
// "connected" status. Distinguishes REQUIRED_FOR_CORE (none exist today) from
// REQUIRED_FOR_OPTIONAL_INTEGRATION (everything below).
function validateEnv(env) {
 const optionalIntegrations=[
  ['Anthropic (AI)',['ANTHROPIC_API_KEY / AI_API_KEY','ANTHROPIC_MODEL / AI_DEFAULT_MODEL'],!!(env.AI_API_KEY||env.ANTHROPIC_API_KEY)&&!!(env.AI_DEFAULT_MODEL||env.ANTHROPIC_MODEL)],
  ['Salla catalog sync',['SALLA_ACCESS_TOKEN, or SALLA_CLIENT_ID/SALLA_CLIENT_SECRET/SALLA_REDIRECT_URI for OAuth'],!!env.SALLA_ACCESS_TOKEN||!!(env.SALLA_CLIENT_ID&&env.SALLA_CLIENT_SECRET&&env.SALLA_REDIRECT_URI)],
  ['Salla OAuth token encryption',['INTEGRATION_ENCRYPTION_KEY'],!env.SALLA_CLIENT_ID||credentialsConfigured(env)],
  ['Salla webhooks',['SALLA_WEBHOOK_SECRET'],!!env.SALLA_WEBHOOK_SECRET],
  ['WhatsApp',['WHATSAPP_ACCESS_TOKEN, or connect Meta via OAuth below'],!!env.WHATSAPP_ACCESS_TOKEN||!!(env.META_APP_ID&&env.META_APP_SECRET&&env.META_REDIRECT_URI)],
  ['Meta (Instagram/Facebook)',['META_ACCESS_TOKEN, or META_APP_ID/META_APP_SECRET/META_REDIRECT_URI for OAuth'],!!env.META_ACCESS_TOKEN||!!(env.META_APP_ID&&env.META_APP_SECRET&&env.META_REDIRECT_URI)],
  ['Meta OAuth token encryption',['INTEGRATION_ENCRYPTION_KEY'],!env.META_APP_ID||credentialsConfigured(env)],
  ['Meta webhooks',['META_WEBHOOK_SECRET or META_APP_SECRET','META_VERIFY_TOKEN'],!!(env.META_WEBHOOK_SECRET||env.META_APP_SECRET)&&!!env.META_VERIFY_TOKEN],
  ['X',['X_CLIENT_ID/X_CLIENT_SECRET/X_REDIRECT_URI for OAuth (required — publishing needs a user-context token; X_BEARER_TOKEN alone is read-only)'],!!(env.X_CLIENT_ID&&env.X_CLIENT_SECRET&&env.X_REDIRECT_URI)],
  ['X OAuth token encryption',['INTEGRATION_ENCRYPTION_KEY'],!env.X_CLIENT_ID||credentialsConfigured(env)],
  ['LinkedIn',['LINKEDIN_CLIENT_ID/SECRET/REDIRECT_URI for OAuth, or LINKEDIN_ACCESS_TOKEN+LINKEDIN_ORGANIZATION_ID'],!!(env.LINKEDIN_CLIENT_ID&&env.LINKEDIN_CLIENT_SECRET&&env.LINKEDIN_REDIRECT_URI)||!!(env.LINKEDIN_ACCESS_TOKEN&&env.LINKEDIN_ORGANIZATION_ID)],
  ['LinkedIn OAuth token encryption',['INTEGRATION_ENCRYPTION_KEY'],!env.LINKEDIN_CLIENT_ID||credentialsConfigured(env)],
  ['Microsoft 365',['MICROSOFT_ACCESS_TOKEN, or MICROSOFT_CLIENT_ID/SECRET/TENANT_ID/REDIRECT_URI for OAuth'],!!env.MICROSOFT_ACCESS_TOKEN||!!(env.MICROSOFT_CLIENT_ID&&env.MICROSOFT_CLIENT_SECRET&&env.MICROSOFT_REDIRECT_URI)],
  ['Microsoft 365 OAuth token encryption',['INTEGRATION_ENCRYPTION_KEY'],!env.MICROSOFT_CLIENT_ID||credentialsConfigured(env)],
  ['Microsoft 365 mail webhook',['MICROSOFT_WEBHOOK_SECRET'],!!env.MICROSOFT_WEBHOOK_SECRET],
  ['Canva',['CANVA_API_KEY'],!!env.CANVA_API_KEY],
  ['Zid',['ZID_CLIENT_ID/ZID_CLIENT_SECRET/ZID_REDIRECT_URI for OAuth'],!!(env.ZID_CLIENT_ID&&env.ZID_CLIENT_SECRET&&env.ZID_REDIRECT_URI)],
  ['Zid OAuth token encryption',['INTEGRATION_ENCRYPTION_KEY'],!env.ZID_CLIENT_ID||credentialsConfigured(env)]
 ];
 for(const [name,vars,configured] of optionalIntegrations)
  if(!configured)console.warn(`[HyperCool] REQUIRED_FOR_OPTIONAL_INTEGRATION — ${name} not configured (missing: ${vars.join(', ')}). Core app and CRM are unaffected; only this integration's tools stay INTEGRATION_REQUIRED.`);
 const configuredCount=optionalIntegrations.filter(o=>o[2]).length;
 console.log(`[HyperCool] environment check: ${configuredCount}/${optionalIntegrations.length} optional integrations configured. SYSTEM_MODE=${env.SYSTEM_MODE||'(unset — autonomy levels run uncapped; set PRODUCTION_SAFE to cap every agent at L1 for first launch)'}.`);
}

// Phase 6E, Part 3/51/56 — the generic multi-connection OAuth routes below dispatch through
// this FIXED, code-reviewed allowlist only — a tenant can never supply their own
// authorize/token URL (Part 3: "No Generic Unsafe OAuth"). Adding a future approved OAuth2
// connector means adding one more entry here, never widening the route itself to accept an
// arbitrary provider.
const GENERIC_OAUTH_PROVIDERS={
 salla:{createAuthorizeUrl,exchangeCodeForTokens,defaultConnectionName:'متجر سلة جديد',resolveIdentity:null},
 zid:{createAuthorizeUrl:createZidAuthorizeUrl,exchangeCodeForTokens:exchangeZidCodeForTokens,defaultConnectionName:'متجر زد جديد',resolveIdentity:resolveZidIdentity}
};

export async function createApp({env=process.env,dataDir=env.DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url)),fetcher=fetch}={}) {
  const publicUrl=env.PUBLIC_ORIGIN?new URL(env.PUBLIC_ORIGIN):null;
  if(publicUrl && (publicUrl.protocol!=='https:' || publicUrl.username || publicUrl.password || publicUrl.pathname!=='/' || publicUrl.search || publicUrl.hash)) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a path');
  const secureCookie=publicUrl?'; Secure':'';
  await mkdir(dataDir,{recursive:true});
  const store=openStore(resolve(dataDir,'hypercool.sqlite'),resolve(dataDir,'state.json'));
  const auth=createAuth(store.db);
  // Multi-Tenant Phase 4C-6 (Part 34/72) — a simple, in-process per-user guard against a
  // double-click/network-retry firing two overlapping `POST /api/workspaces` requests from the
  // SAME user before the first has finished its transaction. Scoped to this one `createApp()`
  // instance (not a module-level singleton) so separate app instances — every test fixture,
  // for one — never share or leak this state across each other.
  const workspaceCreationInFlight=new Set();
  installTenancy(store.db);
  ensureDefaultTenant(store.db); // real, lossless backfill — see docs/MULTI_TENANT_ARCHITECTURE.md
  installInvitations(store.db); // Multi-Tenant Phase 4C-3 — see docs/WORKSPACE_INVITATIONS.md
  installOnboarding(store.db); // Multi-Tenant Phase 4C-4 — see docs/WORKSPACE_ONBOARDING.md
  installPlatformIdentity(store.db); // Multi-Tenant Phase 4C-5 — see docs/PLATFORM_IDENTITY.md
  installPlatformMail(store.db);
  installPartnerProgram(store.db); // Frost Partners: additive tables + editable starter plans, see docs/PARTNERS.md // Multi-Tenant Phase 4C-5 — see docs/PLATFORM_EMAIL.md
  installContent(store.db); // migrates legacy state.content into a real tenant-scoped table — see docs/CONTENT_MIGRATION.md
  installAuditLog(store.db); // migrates legacy state.audit into a real tenant-scoped table — see docs/AUDIT_MIGRATION.md
  installKnowledge(store.db);
  installPlanning(store.db);
  migrateUnifyContentItems(store.db); // Content Unification — must run after installPlanning() since it creates real schedule_jobs rows for previously-scheduled campaign content; see docs/CONTENT_MIGRATION.md
  installCRM(store.db);
  installCompliance(store.db);
  installAutonomy(store.db);
  installReporting(store.db);
  installRegistry(store.db);
  installRuntimeTables(store.db);
  installEvents(store.db);
  installApprovals(store.db);
  installEscalations(store.db);
  installContextItems(store.db);
  installSuggestions(store.db);
  installCommandChat(store.db);
  installAttachments(store.db);
  installConfigurationHistory(store.db);
  installRunbooks(store.db);
  installMarketing(store.db); // Phase MKT-1 — Marketing & Social Operating Module, see docs/MARKETING_MODULE.md
  installMarketingAnalytics(store.db); // Phase MKT-2, Part F — normalized cross-provider analytics metrics
  installWebsiteWidgets(store.db);
  installWorkflowEngine(store.db);
  installPlatformFrostChat(store.db);
  installGate(store.db);
  installIntegrationDefinitions(store.db); // Multi-Tenant Phase 4A — global integration catalog, see docs/INTEGRATION_CONNECTION_ARCHITECTURE.md
  installIntegrationConnections(store.db);
  installCredentialsVault(store.db);
  installDynamicConnectorTables(store.db); // Phase 6D — persistent Connector Definition actions/triggers/versions
  installDraftOverlayTables(store.db); // Phase 6H — parallel draft workspace (Safe Published Version Lifecycle)
  installBulkOperations(store.db); // Phase 6H — bulk version migration / webhook reprocess operations log
  installOAuthStates(store.db);
  installCredentials(store.db);
  migrateLegacyIntegrationCredentials(store.db,env); // one-time-per-row copy into the new connection+vault model
  installWebhookEvents(store.db);
  installWhatsAppTemplates(store.db);
  seedRegistry(store.db);
  // Multi-Tenant Phase 4B — Agent Tool Assignment + Tool-to-Connection Mapping + Agent
  // Readiness, see docs/AGENT_TOOL_MAPPING.md. `tool_definitions` must install AFTER
  // seedRegistry (no real dependency, just keeping every "seed a global catalog" call
  // grouped) and BEFORE the tenant config seed loop below, which reads agent_registry's
  // legacy enabled flag as its one-time migration default (Part 49/91: no data loss).
  installToolDefinitions(store.db);
  installTenantAgentConfigs(store.db);
  installClientPortal(store.db);
  if(env.NODE_ENV==='production'){const devSeed=countDevSeedAccounts(store.db);if(devSeed>0)console.error(JSON.stringify({level:'ERROR',message:'DEV_PREVIEW_ACCOUNTS_PRESENT_IN_PRODUCTION',count:devSeed}));} // Frost merchant portal: additive tables + editable starter plans, see docs/CLIENT_PORTAL.md
  installAgentToolAssignments(store.db);
  for(const {id:tenantId} of store.db.prepare('SELECT id FROM tenants').all())seedTenantAgentConfigs(store.db,tenantId);
  const eventBus=createEventBus(store.db);
  const agentRuntime=createAgentRuntime({store,env,fetcher,eventBus,runGate:makeRunGate(store.db,env)});
  const {routes:orchestratorRoutes}=installOrchestrator(eventBus,agentRuntime,store.db);
  // Phase 7C — Native Workflow Engine. `workflowDeps` is passed to every workflow-engine.js
  // entry point instead of each one re-deriving store/env/fetcher/agentRuntime/toolRegistry —
  // the SAME real agentRuntime (and its SAME real toolRegistry) every agent run already uses,
  // never a second one built for workflows.
  const workflowDeps={store,env,fetcher,agentRuntime,toolRegistry:agentRuntime.toolRegistry,startGate:makeWorkflowGate(store.db)};
  installWorkflowEventTriggers(eventBus,workflowDeps);
  function reportExtras(tenantId=null) {
    return {agents:listRegistryAgents(store.db),agentRuns:listRuns(store.db,{limit:2000},tenantId),escalations:listEscalations(store.db,{},tenantId),approvals:listApprovals(store.db,{},tenantId),env};
  }
  const scheduler=createScheduler({store,agentRuntime,env,getExtras:reportExtras,fetcher,eventBus,workflowDeps});
  const generate=createGenerator(store,env,fetcher);
  const checkCompliance=createComplianceChecker(store,env,fetcher);
  let syncing=false;
  // Guards real, billed LLM calls (content drafts, compliance checks, manual agent test
  // runs) against a single authenticated user hammering the Anthropic API with repeated
  // sequential requests — the per-route idempotency/concurrency locks only stop duplicates
  // or overlap, not a fast sequential loop. Fixed window, in-memory, per-user.
  const llmCallLog=new Map();
  function checkLlmRateLimit(userId) {
    const now=Date.now(),windowMs=600000,limit=20;
    const hits=(llmCallLog.get(userId)||[]).filter(at=>now-at<windowMs);
    if(hits.length>=limit) fail(429,'تجاوزت حد الطلبات المسموح لهذه الميزة؛ حاول لاحقًا');
    hits.push(now);llmCallLog.set(userId,hits);
  }
  async function body(req) {
    if(!req.headers['content-type']?.startsWith('application/json')) fail(415,'JSON مطلوب');
    let value='';
    for await(const chunk of req) {value+=chunk; if(Buffer.byteLength(value)>64000) fail(413,'الطلب كبير جدًا');}
    let parsed;try {parsed=JSON.parse(value||'{}');} catch {fail(400,'JSON غير صالح');}
    if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)) fail(400,'كائن JSON مطلوب');
    return parsed;
  }
  // Webhook signature verification needs the exact raw bytes Salla signed — body() above
  // JSON-parses immediately and would lose that, so this is a separate, minimal reader.
  const partnerRoutes=createPartnerRoutes({store,env,auth,fetcher,readJson:body,secureCookie});
  const clientRoutes=createClientRoutes({store,env,auth,fetcher,agentRuntime,workflowDeps,readJson:body,secureCookie,applyApproval:(decided,ctx)=>applyApprovalDecision(decided,ctx)});
  // Side effects of a decided approval (email send, tool resume, workflow resume, CRM stage change). Shared by the
  // legacy /api/approvals route and the merchant portal so both behave identically.
  async function applyApprovalDecision(decided,{user:actor,tenantId}) {
    // Execution-on-approval, scoped to exactly one action type: an approved email send.
    // This is the one place in the whole Approval Center where deciding APPROVED also
    // performs the real side effect — every other approval type (memory, permission
    // changes, etc.) stays decision-only, matching the existing pattern (spec Part O:
    // "use existing Approval Center, don't duplicate logic" — this reuses it rather
    // than inventing a parallel "pending email" queue).
    if(decided.status==='APPROVED' && decided.action_type==='send_marketing_message') {
      const proposed=JSON.parse(decided.proposed_output);
      if(proposed?.to && proposed?.subject && proposed?.bodyHtml) {
        try {
         const sendResult=await sendMail({store,env,fetcher},{to:proposed.to,cc:proposed.cc,subject:proposed.subject,bodyHtml:proposed.bodyHtml},tenantId);
         if(sendResult.status==='SENT' && proposed.leadId)recordChannelMessage(store,{leadId:proposed.leadId,channel:'Email',direction:'OUTBOUND',text:proposed.bodyHtml,subject:proposed.subject,cc:proposed.cc||null,messageType:'email'},actor,tenantId);
         return {...decided,emailSendResult:sendResult};
        } catch(error) {
         return {...decided,emailSendResult:{status:'FAILED',errorDetail:error.message}};
        }
      }
    }
    // Multi-Tenant Phase 4B (Part 40-42) — the generic resume path for a connection-aware
    // tool gated by ToolDefinition.requiresApprovalBelowLevel (today: whatsapp_send at
    // L1). Re-validates the EXACT connection this approval was raised against is still
    // available (never silently re-targets a different one — see
    // runtime.js's resumeToolApproval) and re-invokes the SAME tool handler that would
    // have run immediately at a higher permission level — no second execution path.
    // Phase 7C — a `agent_tool_send` approval raised by a Workflow TOOL step (spec Part 15)
    // shares the exact same action_type as a normal agent tool call (no new approval type
    // needed for it) — distinguished only by whether its `run_id` is a real
    // workflow_step_runs id, then routed through resumeWorkflowApproval so the workflow
    // actually advances afterward (a bare agentRuntime.resumeToolApproval call would
    // execute the write but leave the run stuck WAITING_APPROVAL forever).
    const isWorkflowToolApproval=decided.action_type==='agent_tool_send' && !!store.db.prepare('SELECT 1 FROM workflow_step_runs WHERE id=?').get(decided.run_id);
    if(decided.action_type==='workflow_step_approval'||isWorkflowToolApproval) {
      const resumed=await resumeWorkflowApproval(workflowDeps,decided);
      recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKFLOW_APPROVAL_DECIDED',itemId:decided.id,detail:{decision:decided.status,workflowRunId:resumed.id},actorId:actor.id,actorName:actor.name,at:new Date().toISOString()},tenantId);
      return {...decided,workflowRun:resumed};
    }
    if(decided.status==='APPROVED' && decided.action_type==='agent_tool_send') {
      const toolResult=await agentRuntime.resumeToolApproval(decided);
      recordAudit(store.db,{id:crypto.randomUUID(),action:'AGENT_TOOL_APPROVAL_EXECUTED',itemId:decided.id,toolSlug:decided.tool_slug,resultStatus:toolResult?.status||null,actorId:actor.id,actorName:actor.name,at:new Date().toISOString()},tenantId);
      return {...decided,toolResult};
    }
    // Phase MKT-2, Part E — a sensitive CRM pipeline-stage change proposed by a real sales
    // agent run, approved by a human. Applies through the exact same updateLead function a
    // human editing the CRM form uses; a REJECTED decision simply leaves the lead unchanged
    // (decideApproval above already recorded the rejection).
    if(decided.status==='APPROVED' && decided.action_type==='marketing_crm_stage_update') {
      const proposed=JSON.parse(decided.proposed_output);
      try {
       const lead=getLead(store.db,proposed.leadId,tenantId);
       const updated=updateLead(store,proposed.leadId,{stage:proposed.toStage,temperature:lead.temperature,expectedVersion:lead.version,reason:`اعتماد بشري لاقتراح الوكيل ${decided.agent_id} (${decided.id})`,city:lead.city,productNeed:lead.productNeed,productUrl:lead.productUrl,quantity:lead.quantity,valueSAR:lead.valueSAR,timeline:lead.timeline,budgetBand:lead.budgetBand,nextCheckAt:lead.nextCheckAt,assignedTo:lead.assignedTo},actor,tenantId);
       return {...decided,leadUpdateResult:{status:'APPLIED',lead:updated}};
      } catch(error) {
       return {...decided,leadUpdateResult:{status:'FAILED',errorDetail:error.message}};
      }
    }
    return decided;
  }
  async function rawBody(req,maxBytes=1000000) {
    const chunks=[];let size=0;
    for await(const chunk of req) {size+=chunk.length;if(size>maxBytes) fail(413,'الطلب كبير جدًا');chunks.push(chunk);}
    return Buffer.concat(chunks).toString('utf8');
  }
  // Structured, production-safe logging: one JSON line per request (never the request/response
  // body, which could carry a password or a customer's raw message), correlated by a
  // per-request id that's also returned as X-Request-Id so a user-reported error can be
  // traced back to this exact log line.
  function logRequest(fields) {
    console.log(JSON.stringify({timestamp:new Date().toISOString(),level:fields.status>=500?'ERROR':fields.status>=400?'WARN':'INFO',...fields}));
  }
  // Website AI Chat Widget public endpoint (Phase MKT-1, spec Part 28-29/89-90). The ONE
  // route in this whole app reachable cross-origin from an arbitrary tenant's own website —
  // see the isPublicWidgetRoute carve-out above. No session, no secret ever reaches the
  // frontend: the widget script only ever knows its own public, non-secret widget id. Real
  // security comes from the widget's own configured domain allowlist (isOriginAllowed) plus a
  // per-(widget,ip) rate limit — never a session cookie or CSRF token, which a cross-origin
  // caller cannot present. Reuses the exact same findOrCreateLeadFromChannel/
  // recordChannelMessage functions the WhatsApp/Email webhooks already use (channel=
  // 'WebsiteChat'), and the exact same agentRuntime.run('sales', …) pipeline every other
  // inbound customer message goes through — no second, ad-hoc "just call the LLM" path.
  async function handlePublicWidgetRoute(req,res,url,send,requestId,startedAt) {
    const origin=req.headers.origin||'';
    const match=url.pathname.match(/^\/api\/public\/widget\/([\w-]+)\/chat$/);
    const respond=(status,value,extraHeaders={})=>{
      for(const [key,val] of Object.entries(extraHeaders))res.setHeader(key,val);
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
      res.end(value===undefined?'':JSON.stringify(value));
      logRequest({request_id:requestId,method:req.method,path:url.pathname,status,duration_ms:Date.now()-startedAt,user_id:null});
    };
    if(!match)return respond(404,{error:'NOT_FOUND'});
    const publicWidgetId=match[1];
    if(req.method==='OPTIONS') {
      const widget=resolveActiveWidgetByPublicId(store.db,publicWidgetId);
      const headers={'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'};
      if(widget && isOriginAllowed(widget,origin))headers['Access-Control-Allow-Origin']=origin;
      return respond(204,undefined,headers);
    }
    if(req.method!=='POST')return respond(405,{error:'METHOD_NOT_ALLOWED'});
    try {
      const widget=resolveActiveWidgetByPublicId(store.db,publicWidgetId);
      if(!widget)fail(404,'الودجت غير موجود أو غير مفعّل');
      if(!isOriginAllowed(widget,origin))fail(403,'هذا النطاق غير مسموح له باستخدام هذا الودجت');
      const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();
      checkWidgetRateLimit(publicWidgetId,ip);
      const raw=await rawBody(req,20000);
      let payload;try{payload=JSON.parse(raw||'{}');}catch{fail(400,'JSON غير صالح');}
      const text=typeof payload.text==='string'?payload.text.trim().slice(0,2000):'';
      if(!text)fail(400,'الرسالة مطلوبة');
      const name=typeof payload.name==='string'?payload.name.trim().slice(0,200):null;
      const phone=typeof payload.phone==='string'?payload.phone.trim().slice(0,40):null;
      const email=typeof payload.email==='string'?payload.email.trim().slice(0,200):null;
      const existingLeadId=typeof payload.leadId==='string'?payload.leadId:null;
      const {lead,message}=recordWidgetInboundMessage(store,{tenantId:widget.tenantId,name,phone,email,text,existingLeadId});
      const corsHeaders={'Access-Control-Allow-Origin':origin};
      if(message.replayed)return respond(200,{leadId:lead.id,replayed:true},corsHeaders);
      if(message.optedOut)eventBus.emit('CUSTOMER_OPTED_OUT',{leadId:lead.id,channel:'WebsiteChat',tenantId:widget.tenantId});
      // A real, synchronous call through the exact same sales-agent decision pipeline the
      // async WhatsApp/Email channels use — the widget just awaits it directly instead of the
      // reply arriving over a separate channel later, since the visitor is watching this same
      // window right now. If AI is not configured/fails, this is reported honestly — never a
      // fabricated reply.
      const run=await agentRuntime.run('sales',{triggerType:'CHANNEL_MESSAGE',input:{channel:'WebsiteChat',leadId:lead.id,message:text,current_datetime:new Date().toISOString(),timezone:'Asia/Riyadh'},tenantId:widget.tenantId});
      const replyText=run.output?.payload?.[payload.locale==='en'?'reply_en':'reply_ar']||run.output?.payload?.reply_ar||run.output?.payload?.reply_en||null;
      if(replyText)recordWidgetOutboundReply(store,{tenantId:widget.tenantId,leadId:lead.id,text:replyText});
      // Phase MKT-2, Part E — the sales agent's real decision may propose real CRM updates.
      // Safe (non-stage) fields auto-apply through the existing updateLead function; a
      // proposed STAGE change never auto-applies — it becomes a real, visible Approval Center
      // entry instead, exactly like every other sensitive agent action in this system.
      if(run.output?.payload) {
       const {safe,stageProposal}=extractSafeCrmUpdates(run.output.payload);
       try {
        if(Object.keys(safe).length)applySafeCrmUpdates(store,lead.id,safe,{runId:run.id,agentId:'sales'},widget.tenantId);
        if(stageProposal && stageProposal!==lead.stage)proposeStageChangeApproval(store.db,{leadId:lead.id,fromStage:lead.stage,toStage:stageProposal,runId:run.id,agentId:'sales'},widget.tenantId);
       } catch(crmUpdateError) {
        // Never let a malformed/edge-case CRM update proposal break the visitor's chat reply —
        // the message and lead are already safely recorded regardless of this outcome.
        recordAudit(store.db,{id:crypto.randomUUID(),action:'AGENT_CRM_UPDATE_FAILED',itemId:lead.id,detail:{runId:run.id,error:crmUpdateError.message},at:new Date().toISOString()},widget.tenantId);
       }
      }
      return respond(200,{leadId:lead.id,reply:replyText,aiAvailable:!!replyText,escalated:!!run.output?.escalation_required},corsHeaders);
    } catch(error) {
      const status=error.status||500;
      return respond(status,{error:error.message||'INTERNAL_ERROR'},{'Access-Control-Allow-Origin':origin});
    }
  }
  const server=http.createServer(async(req,res)=>{
    const requestId=crypto.randomUUID();
    const startedAt=Date.now();
    let userId=null;
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Request-Id',requestId);
    const send=(status,value)=>{
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
      res.end(JSON.stringify(value));
      logRequest({request_id:requestId,method:req.method,path:req.url.split('?')[0],status,duration_ms:Date.now()-startedAt,user_id:userId,error_code:status>=400?value?.error:undefined});
    };
    try {
      const host=req.headers.host;
      if(!host || (publicUrl?host!==publicUrl.host:!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))) fail(403,'Host not allowed');
      const earlyUrl=new URL(req.url,`http://${host}`);
      // Website AI Chat Widget (Phase MKT-1, spec Part 28-29) — the ONE deliberately
      // cross-origin-reachable surface in this app: it must be callable from an arbitrary
      // tenant's own external website, so the app-wide same-origin gates below (which every
      // other route relies on, session-cookie style) cannot apply to it. Its own
      // origin/domain allowlist (isOriginAllowed, checked per-tenant against real configured
      // domains) is the real security boundary here instead — never a session, never a
      // secret, never a wildcard CORS header.
      const isPublicWidgetRoute=earlyUrl.pathname.startsWith('/api/public/widget/');
      if(!isPublicWidgetRoute) {
        if(req.headers.origin && req.headers.origin!==(publicUrl?.origin||`http://${host}`)) fail(403,'Cross-origin request rejected');
      }
      // Part 45 — the ONE base used to build every outbound account/invitation link (email
      // verification, password reset, invitation accept). Never inferred from an arbitrary
      // client-controlled header: `host` above is already validated against the configured
      // `PUBLIC_ORIGIN` (or the localhost-only pattern) two lines up, so this can never be
      // spoofed into pointing an emailed link at an attacker-controlled domain.
      const baseUrl=publicUrl?.origin||`http://${host}`;
      const url=earlyUrl;
      if(isPublicWidgetRoute)return handlePublicWidgetRoute(req,res,url,send,requestId,startedAt);
      // External links may open the public shell; API and embedded requests remain protected.
      const publicNavigation=req.method==='GET' && (url.pathname==='/' || url.pathname==='/partners' || url.pathname==='/client' || url.pathname==='/client/register' || /^\/r\/[A-Za-z0-9]{4,16}$/.test(url.pathname) ||
        // an OAuth provider redirecting the browser back (cross-site by nature); the signed single-use state is its authority
        /^\/api\/client\/integrations\/[a-z0-9]+\/callback$/.test(url.pathname)) &&
        req.headers['sec-fetch-mode']==='navigate' && req.headers['sec-fetch-dest']==='document';
      if(req.headers['sec-fetch-site']==='cross-site' && !publicNavigation) fail(403,'Cross-site request rejected');
      if(url.pathname.startsWith('/api/automation/')) {
        authorizeAutomation(req,env);
        const actor={id:'automation',name:'مشغّل خارجي',role:'automation'};
        // This external-trigger path duplicates exactly what the internal scheduler already
        // does on its own — so it must obey the same "pause all autonomous actions" gate,
        // not just the scheduler's own tick(). Otherwise pausing from Frost Control Center
        // would silently fail to stop this path.
        if(req.method==='POST' && (url.pathname==='/api/automation/daily-brief'||url.pathname==='/api/automation/prepare-due') && isPaused(store.db))return send(200,{skipped:'PAUSED'});
        // Multi-Tenant Phase 3.5: this external-trigger path calls the exact same tenant-aware
        // job functions the internal scheduler's tick() does, so it must also loop over every
        // eligible tenant (ACTIVE/TRIAL) rather than the single implicit tenant a bare
        // `resolveActiveTenantId` default would throw TENANT_CONTEXT_REQUIRED on once a second
        // tenant exists. Same per-tenant result shape as tick() for consistency.
        if(req.method==='POST' && url.pathname==='/api/automation/daily-brief')return send(200,{tenants:Object.fromEntries(listTenants(store.db).map(tenant=>[tenant.id,saveDailyBrief(store,riyadhDate(),actor,tenant.id)]))});
        if(req.method==='POST' && url.pathname==='/api/automation/prepare-due')return send(200,{tenants:Object.fromEntries(listTenants(store.db).map(tenant=>[tenant.id,prepareDue(store,actor,Date.now(),eventBus,env,tenant.id)]))});
        if(req.method==='GET' && url.pathname==='/api/automation/status')return send(200,{timezone:'Asia/Riyadh',externalPublishing:false});
        fail(404,'Unknown automation operation');
      }
      // Unauthenticated on purpose, like /api/automation/* above — this is Salla's own
      // server calling us, not a browser with a session. Authenticity comes entirely from
      // verifySallaWebhook() (signature or token match against SALLA_WEBHOOK_SECRET), never
      // from a session cookie or CSRF token. Verify → store (idempotent) → map → return fast.
      if(req.method==='POST' && url.pathname==='/api/webhooks/salla') {
        const raw=await rawBody(req);
        verifySallaWebhook(req,raw,env);
        let payload;try{payload=JSON.parse(raw||'{}');}catch{fail(400,'JSON غير صالح');}
        // Multi-Tenant Phase 3.5 (Part B): tenant is resolved from Salla's own verified
        // `merchant` field — never trusted from anything the payload claims to be otherwise —
        // see resolveTenantForSallaMerchant for the honest self-registration bootstrap this
        // relies on today (no live Salla app to verify a real connect-time merchant fetch).
        const resolvedTenantId=resolveTenantForSallaMerchant(store.db,payload?.merchant??null);
        return send(200,processSallaWebhook({db:store.db,eventBus,body:payload,paused:isPaused(store.db),tenantId:resolvedTenantId}));
      }
      // Meta's verification handshake — GET with hub.challenge, no body, no signature (the
      // handshake IS the authentication: only someone holding META_VERIFY_TOKEN can pass it).
      if(req.method==='GET' && url.pathname==='/api/webhooks/meta/whatsapp') {
        res.writeHead(200,{'Content-Type':'text/plain'});return res.end(handleVerificationChallenge(url.searchParams,env));
      }
      // Real inbound WhatsApp delivery. Same unauthenticated-by-session, authenticated-by-
      // secret pattern as /api/webhooks/salla — see verifyMetaSignature. This is the one
      // route the whole PART F flow (webhook → CUSTOMER_MESSAGE_RECEIVED → Frost → Sales
      // Agent) starts from.
      if(req.method==='POST' && url.pathname==='/api/webhooks/meta/whatsapp') {
        const raw=await rawBody(req);
        verifyMetaSignature(req,raw,env);
        let payload;try{payload=JSON.parse(raw||'{}');}catch{fail(400,'JSON غير صالح');}
        // Multi-Tenant Phase 3.5 (Part B10): tenant is resolved per delivery from Meta's own
        // verified metadata.phone_number_id — never trusted from anything the payload claims
        // to be otherwise. See webhook-tenant-resolver.js.
        const normalized=normalizeWhatsAppWebhook(store.db,payload,phoneNumberId=>resolveTenantForWhatsAppPhoneNumberId(store.db,phoneNumberId));
        const paused=isPaused(store.db);
        const connectorActor={id:'connector:whatsapp',name:'موصل واتساب',role:'automation'};
        for(const item of normalized.messages) {
          if(item.replayed||item.error||item.unresolved||!item.phone)continue;
          const {lead}=findOrCreateLeadFromChannel(store,{phone:item.phone,name:item.name,channel:'WhatsApp'},connectorActor,item.tenantId);
          const message=recordChannelMessage(store,{leadId:lead.id,channel:'WhatsApp',direction:'INBOUND',text:item.text,externalMessageId:item.externalMessageId,messageType:item.messageType,media:item.media||null},connectorActor,item.tenantId);
          if(message.replayed)continue;
          if(message.optedOut)eventBus.emit('CUSTOMER_OPTED_OUT',{leadId:lead.id,channel:'WhatsApp',tenantId:item.tenantId});
          // The pause gate stops autonomous AGENT action, never the recording of the message
          // itself — a paused system must still capture what the customer said, exactly like
          // the internal scheduler's own tick() only skips its own triggered work, not intake.
          if(!paused)eventBus.emit('CUSTOMER_MESSAGE_RECEIVED',{leadId:lead.id,channel:'WhatsApp',text:item.text,tenantId:item.tenantId});
        }
        for(const item of normalized.statuses) {
          if(item.replayed||item.unresolved)continue;
          updateMessageStatus(store,item.externalMessageId,item.status,{errorCode:item.errorCode});
        }
        return send(200,{received:normalized.messages.length,statuses:normalized.statuses.length,skipped:normalized.skipped});
      }
      // Phase MKT-2, Part I — real Facebook Messenger + Instagram DM/comment inbound. Same
      // verification/signature/dedup/tenant-resolution discipline as the WhatsApp route above
      // (this is genuinely the SAME Meta App webhook mechanism, just different subscribed
      // fields) — no second inbox database, no separate signature scheme. `body.object` tells
      // us whether this delivery is Messenger ('page') or Instagram ('instagram'); comments
      // arrive as `entry[].changes[]` alongside (or instead of) `entry[].messaging[]`, so both
      // normalizers run over the same parsed payload.
      if(req.method==='GET' && url.pathname==='/api/webhooks/meta/social') {
        res.writeHead(200,{'Content-Type':'text/plain'});return res.end(handleVerificationChallenge(url.searchParams,env));
      }
      if(req.method==='POST' && url.pathname==='/api/webhooks/meta/social') {
        const raw=await rawBody(req);
        verifyMetaSignature(req,raw,env);
        let payload;try{payload=JSON.parse(raw||'{}');}catch{fail(400,'JSON غير صالح');}
        const resolveTenant=pageOrIgId=>resolveTenantForMetaPageId(store.db,pageOrIgId);
        const messaging=normalizeMetaMessagingWebhook(store.db,payload,resolveTenant);
        const comments=normalizeMetaCommentWebhook(store.db,payload,resolveTenant);
        const paused=isPaused(store.db);
        const connectorActor={id:'connector:meta-social',name:'موصل التواصل الاجتماعي',role:'automation'};
        for(const item of messaging.messages) {
         if(item.replayed||item.error||item.unresolved||!item.senderId)continue;
         const {lead}=findOrCreateLeadFromChannel(store,{externalContactId:item.senderId,channel:item.platform,name:null},connectorActor,item.tenantId);
         const message=recordChannelMessage(store,{leadId:lead.id,channel:item.platform,direction:'INBOUND',text:item.text,externalMessageId:item.externalMessageId,messageType:item.messageType,media:item.media||null},connectorActor,item.tenantId);
         if(message.replayed)continue;
         if(!paused)eventBus.emit('CUSTOMER_MESSAGE_RECEIVED',{leadId:lead.id,channel:item.platform,text:item.text,tenantId:item.tenantId});
        }
        // Comments intake real customer text into the CRM/lead model (Part I: "supported
        // comments/replies") but never auto-triggers an agent — a public comment is not a
        // private conversation, and this codebase has no public-reply tool for either
        // platform; a human can act on it from the Shared Inbox like any other real message.
        for(const item of comments.comments) {
         if(item.replayed||item.error||item.unresolved||!item.senderId)continue;
         const {lead}=findOrCreateLeadFromChannel(store,{externalContactId:item.senderId,channel:item.platform,name:null},connectorActor,item.tenantId);
         recordChannelMessage(store,{leadId:lead.id,channel:item.platform,direction:'INBOUND',text:item.text,externalMessageId:item.externalCommentId,messageType:'comment'},connectorActor,item.tenantId);
        }
        return send(200,{received:messaging.messages.length,comments:comments.comments.length,skipped:messaging.skipped+comments.skipped});
      }
      // Microsoft Graph's real webhook mechanism is different from Meta's/Salla's: EVERY
      // POST (including the very first, which is the validation handshake) hits the same
      // URL. A validation POST carries ?validationToken=... and must get that token echoed
      // back as plain text within 10 seconds — no JSON body to parse, no secret involved
      // (the handshake just proves we control this URL). Real notifications carry a JSON
      // body instead and are verified per-item via clientState (see microsoft-webhooks.js).
      if(req.method==='POST' && url.pathname==='/api/webhooks/microsoft/mail') {
        const token=handleValidationHandshake(url);
        if(token!==null){res.writeHead(200,{'Content-Type':'text/plain'});return res.end(token);}
        const raw=await rawBody(req);
        let payload;try{payload=JSON.parse(raw||'{}');}catch{fail(400,'JSON غير صالح');}
        // Multi-Tenant Phase 3.5 (Part B12): tenant is resolved per notification item from
        // the real Graph subscriptionId — verified via clientState first, then matched
        // against the subscription id recorded at real /api/integrations/microsoft/subscribe
        // time. Never trusted from anything the payload claims to be otherwise.
        const result=processMicrosoftNotifications(store.db,payload,env,subscriptionId=>resolveTenantForMicrosoftSubscription(store.db,subscriptionId));
        const paused=isPaused(store.db);
        const connectorActor={id:'connector:microsoft365',name:'موصل Microsoft 365',role:'automation'};
        for(const {messageId,tenantId:itemTenantId} of result.toFetch) {
          try {
           const graphMessage=await getMessage({store,env,fetcher},messageId,itemTenantId);
           if(!graphMessage||graphMessage.isDraft)continue; // never ingest our own drafts as if a customer sent them
           const fromAddress=graphMessage.from?.emailAddress?.address||null;
           if(!fromAddress)continue;
           const {lead}=findOrCreateLeadFromChannel(store,{email:fromAddress,name:graphMessage.from?.emailAddress?.name,channel:'Email'},connectorActor,itemTenantId);
           const message=recordChannelMessage(store,{leadId:lead.id,channel:'Email',direction:'INBOUND',text:graphMessage.bodyPreview||'',subject:graphMessage.subject||null,externalMessageId:graphMessage.id,internetMessageId:graphMessage.internetMessageId,externalThreadId:graphMessage.conversationId,messageType:'email'},connectorActor,itemTenantId);
           if(message.replayed)continue;
           if(message.optedOut)eventBus.emit('CUSTOMER_OPTED_OUT',{leadId:lead.id,channel:'Email',tenantId:itemTenantId});
           if(!paused)eventBus.emit('CUSTOMER_MESSAGE_RECEIVED',{leadId:lead.id,channel:'Email',text:message.text,tenantId:itemTenantId});
          } catch(error) {
           recordAudit(store.db,{id:crypto.randomUUID(),action:'EMAIL_INGEST_FAILED',itemId:messageId,errorCode:error.message,at:new Date().toISOString()},itemTenantId);
          }
        }
        return send(200,{toFetch:result.toFetch.length,rejected:result.rejected,replayed:result.replayed,unresolved:result.unresolved});
      }
      // Universal Integration Platform (Phase 6C, Part 3) — the ONE generic inbound webhook
      // route every future declarative connector uses, so adding a new connector never again
      // means writing a brand-new route here. Unauthenticated on purpose (an external
      // platform, not a browser with a session) — authenticity comes entirely from
      // processGenericWebhook()'s own per-trigger verification (HMAC/header-token/shared-
      // secret against the connection's real Vault secret), never a session/CSRF check. The
      // three existing provider routes above are completely unchanged and untouched.
      const genericWebhook=url.pathname.match(/^\/api\/webhooks\/connectors\/([\w-]+)$/);
      if(req.method==='POST' && genericWebhook) {
        const raw=await rawBody(req);
        const result=await processGenericWebhook({db:store.db,env,eventBus,publicId:genericWebhook[1],rawBody:raw,headers:req.headers});
        return send(200,result);
      }
      // Unauthenticated on purpose — load balancers/uptime monitors never hold a session.
      // Still pass through the Host/Origin/Sec-Fetch checks above, same as everything else.
      if(req.method==='GET' && (url.pathname==='/health'||url.pathname==='/health/live')) {
        return send(200,{status:'ok',timestamp:new Date().toISOString()});
      }
      if(req.method==='GET' && url.pathname==='/health/ready') {
        const dependencies={};
        try{store.db.prepare('SELECT 1').get();dependencies.database='ok';}catch{dependencies.database='error';}
        dependencies.scheduler=scheduler.running()?'running':'stopped';
        dependencies.llm=providerStatus(env).configured?'configured':'not_configured';
        const integrations=integrationStatus(env,store.db);
        for(const [name,status] of Object.entries(integrations))dependencies['integration_'+name]=status.configured?'configured':'not_configured';
        // Multi-Tenant Phase 4C-7 (Part 32) — mail/CAPTCHA are genuinely OPTIONAL subsystems
        // (the app boots and every write path already handles either being unconfigured
        // safely, Part 15/PLATFORM_EMAIL.md); their real state is reported here for
        // observability, but neither can ever fail overall readiness by itself.
        dependencies.platform_mail=platformMailStatus(env).status.toLowerCase();
        dependencies.bot_protection=botProtectionStatus(env).status.toLowerCase();
        const coreOk=dependencies.database==='ok';
        return send(coreOk?200:503,{status:coreOk?'ready':'not_ready',core_status:coreOk?'ok':'degraded',dependencies,timestamp:new Date().toISOString(),version:packageVersion});
      }
      const session=auth.current(req);
      userId=session?.user?.id||null;
      // TenantContext resolution (Multi-Tenant Control Center, Phase 1; Workspace Selection,
      // Phase 4C-1 — see docs/WORKSPACE_SELECTION.md). Resolved once per request from the
      // real TenantMembership table plus this session's persisted (and, on every single
      // request, freshly re-validated) active-workspace selection — never trusted from a
      // query string, request body, or header. A multi-membership user with no valid
      // selection makes `resolveTenantForUser` throw; that is deliberately NOT re-thrown
      // immediately here (see `tenantResolutionError` below) so the workspace-selection
      // routes themselves stay reachable even while every OTHER route is correctly blocked.
      let tenantResolutionError=null;
      if(session) {
       try{session.tenantId=resolveTenantForUser(store.db,session.user.id,session.activeTenantId);}
       catch(error){tenantResolutionError=error;}
       // Authorization inside a workspace uses the role held IN that workspace, never the account-wide legacy users.role.
       if(session.tenantId){const held=getActiveMemberRole(store.db,session.tenantId,session.user.id);if(held&&held!==session.user.role)session.user={...session.user,role:held};}
      }
      if(req.method==='GET' && url.pathname==='/api/auth') {const pc=session?partnerContext(store.db,env,session):null;return send(200,{needsSetup:auth.needsSetup(),user:session?.user||null,csrf:session?.csrf||null,isPlatformAdmin:isPlatformAdmin(env,session?.user),partner:pc?{isPartner:!!pc.profile,status:pc.profile?.status||null,isManager:pc.isManager,permissions:pc.permissions}:null,client:session?{isMerchant:isMerchantOnly(store.db,session.user.id)}:null});}
      // Multi-Tenant Phase 4C-7 — logout is a pure session action, never a workspace one.
      // Placed here (before the tenant-resolution throw below) because a session with NO
      // resolvable tenant is a real, valid state — a Platform Admin with zero workspaces of
      // their own (Part 19/20), or a brand-new signup before any workspace exists — and such
      // a user must always be able to log out. Leaving this after the throw (as it was) meant
      // logout itself returned 403 NO_WORKSPACE_ACCESS for exactly those sessions, a real bug
      // only surfaced by this phase's platform-admin-with-zero-workspaces Playwright journey.
      if(req.method==='POST' && url.pathname==='/api/logout') {
        if(session) {
          if(req.headers['x-csrf-token']!==session.csrf) fail(403,'رمز حماية الجلسة غير صالح');
          auth.logout(session);
        }
        res.setHeader('Set-Cookie',`hc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`);
        return send(200,{ok:true});
      }
      if(req.method==='POST' && ['/api/setup','/api/login'].includes(url.pathname)) {
        const input=await body(req);
        let result;
        if(url.pathname==='/api/setup') {
          if(!auth.needsSetup()) fail(409,'تم إعداد حساب المالك بالفعل');
          result=auth.session(auth.createUser(input,'owner'));
        } else result=auth.login(input,req.socket.remoteAddress);
        res.setHeader('Set-Cookie',`hc_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie}`);
        return send(200,{user:result.user,csrf:result.csrf});
      }
      // Multi-Tenant Phase 4C-6 (Part 4-7) — public self-service ACCOUNT registration. This is
      // deliberately narrower than `/api/setup` above (which only ever creates the platform's
      // very first owner, once): any number of new accounts can register here, but this route
      // creates a USER identity ONLY — no tenant, no membership. Placed alongside
      // `/api/setup`/`/api/login`, before the generic authorize()+CSRF gate, since a signing-up
      // visitor has no session yet.
      if(req.method==='POST' && url.pathname==='/api/signup') {
        // Multi-Tenant Phase 4C-7 (Part 3/64) — a pilot can go "invite-only" without any code
        // change at all: setting this to 'false' closes public registration outright while
        // leaving invitation registration (which never touches this route) completely
        // unaffected — Part 46/47's own "signup vs invite are separate intents" holds exactly
        // because they were already two different code paths before this phase.
        if(env.ALLOW_PUBLIC_SIGNUP==='false')fail(403,'التسجيل العام غير متاح حاليًا على هذه المنصة');
        checkSignupRateLimit(req.socket.remoteAddress);
        checkGlobalSignupLimit(env);
        const input=await body(req);
        if(captchaRequiredFor(env,'signup')) {
          const captcha=await verifyBotProtection({env,fetcher},input.captchaToken,req.socket.remoteAddress);
          if(!captcha.ok)fail(400,captcha.errorCode);
        }
        const {user,token,normalizedEmail}=registerPublicUser(store.db,auth,{name:input.name,username:input.username,email:input.email,password:input.password});
        const verifyUrl=`${baseUrl}/app#verify-email/${token}`;
        const locale=['ar','en'].includes(input.locale)?input.locale:'ar';
        const delivery=await sendVerificationEmail({db:store.db,env,fetcher},{to:normalizedEmail,locale,verifyUrl});
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'USER_REGISTERED',itemId:user.id,actorId:user.id,actorName:user.name,at:new Date().toISOString()});
        attributeRegistration(store.db,env,{userId:user.id,email:normalizedEmail,visitorId:req.headers.cookie?.split(';').map(c=>c.trim()).find(c=>c.startsWith('frost_ref='))?.slice(10)||null,ip:(env.PUBLIC_ORIGIN?String(req.headers['x-forwarded-for']||'').split(',')[0].trim():'')||req.socket.remoteAddress});
        // A real, logged-in session from the moment of signup (Part 6) — but the account
        // remains "Account Created, Email Unverified" until the link above is actually
        // clicked; nothing here treats the account as verified or workspace-eligible yet.
        const result=auth.session(store.db.prepare('SELECT * FROM users WHERE id=?').get(user.id));
        res.setHeader('Set-Cookie',`hc_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie}`);
        return send(201,{user:result.user,csrf:result.csrf,delivered:delivery.delivered});
      }
      // Workspace Invitations (Phase 4C-3) — the two PUBLIC, token-authenticated routes.
      // Deliberately unauthenticated (a fresh invitee has no session yet) and therefore
      // handled here, alongside /api/auth|setup|login, before the generic authorize()+CSRF
      // gate below — the invitation TOKEN is these routes' entire authority, never a session.
      // IP-based rate limiting (checkInvitationRateLimit) guards the token-guessing surface.
      const invitationPreview=url.pathname.match(/^\/api\/invitations\/([\w-]+)\/preview$/);
      if(req.method==='GET' && invitationPreview) {
        checkInvitationRateLimit(req.socket.remoteAddress);
        return send(200,previewInvitation(store.db,invitationPreview[1]));
      }
      const invitationRegister=url.pathname.match(/^\/api\/invitations\/([\w-]+)\/register$/);
      if(req.method==='POST' && invitationRegister) {
        checkInvitationRateLimit(req.socket.remoteAddress);
        const token=invitationRegister[1],input=await body(req);
        const role=roleForValidToken(store.db,token); // re-validates the token fully; throws the real reason otherwise
        const created=auth.createUser({username:input.username,name:input.name,password:input.password},role);
        const accepted=acceptInvitation(store.db,token,created.id,{isNewAccount:true});
        recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_INVITATION_ACCEPTED',itemId:accepted.tenantId,actorId:created.id,actorName:created.name,at:new Date().toISOString()},accepted.tenantId);
        // Re-read the fresh row: an EMAIL_BOUND invitation's acceptance (above) may just have
        // set this brand-new account's email/email_verified_at directly — `created` (captured
        // before that update) would otherwise report a stale, empty email in this response.
        const result=auth.session(store.db.prepare('SELECT * FROM users WHERE id=?').get(created.id));
        res.setHeader('Set-Cookie',`hc_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie}`);
        return send(200,{user:result.user,csrf:result.csrf,workspace:{id:accepted.tenantId,name:accepted.tenantName,role:accepted.role}});
      }
      // Platform Identity Phase 4C-5 — three PUBLIC, token-authenticated routes, same
      // placement rationale as the invitation routes above: a visitor clicking an emailed
      // verification/reset link may have no session at all (different browser/device, or an
      // expired one) or, for forgot-password, has no session by definition. Each is guarded by
      // its own real, single-use, hashed, expiring token — never by a request-supplied user id.
      if(req.method==='POST' && url.pathname==='/api/account/email/verify') {
        checkEmailVerificationRateLimit(req.socket.remoteAddress);
        const input=await body(req);
        const result=verifyEmailToken(store.db,input.token);
        markReferralQualified(store.db,result.userId);
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'USER_EMAIL_VERIFIED',itemId:result.userId,actorId:result.userId,at:new Date().toISOString()});
        return send(200,{email:result.email});
      }
      // Part 24 — the response shape is ALWAYS identical regardless of whether the address
      // matches a real, verified account (no user enumeration, Part 41): the generic message
      // is returned unconditionally; only mail-sending (or not) differs behind the scenes.
      if(req.method==='POST' && url.pathname==='/api/auth/forgot-password') {
        checkForgotPasswordRateLimit(req.socket.remoteAddress);
        const input=await body(req);
        if(captchaRequiredFor(env,'forgotPassword')) {
          const captcha=await verifyBotProtection({env,fetcher},input.captchaToken,req.socket.remoteAddress);
          if(!captcha.ok)fail(400,captcha.errorCode); // orthogonal to Part 24's no-enumeration rule — this never reveals account existence, only whether a challenge was solved
        }
        const {token,userId}=requestPasswordReset(store.db,input.email);
        if(token) {
          const resetUrl=`${baseUrl}/app#reset-password/${token}`;
          const locale=['ar','en'].includes(input.locale)?input.locale:'ar';
          await sendPasswordResetEmail({db:store.db,env,fetcher},{to:input.email,locale,resetUrl});
          recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'PASSWORD_RESET_REQUESTED',itemId:userId,actorId:userId,at:new Date().toISOString()});
        }
        return send(200,{message:'إن وُجد حساب مرتبط بهذا البريد، فقد أُرسل إليه رابط إعادة تعيين كلمة المرور.'});
      }
      if(req.method==='POST' && url.pathname==='/api/auth/reset-password') {
        checkForgotPasswordRateLimit(req.socket.remoteAddress);
        const input=await body(req);
        const userId=consumePasswordResetToken(store.db,input.token);
        auth.resetPassword(userId,input.password); // also invalidates every existing session for this user (Part 27)
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'PASSWORD_RESET_COMPLETED',itemId:userId,actorId:userId,at:new Date().toISOString()});
        const user=store.db.prepare('SELECT email,preferred_locale FROM users WHERE id=?').get(userId);
        if(user?.email)await sendSecurityNotice({db:store.db,env,fetcher},{to:user.email,locale:user.preferred_locale||'ar',message:user.preferred_locale==='en'?'Your Frost account password was just reset. If this was not you, contact your workspace owner immediately.':'تم للتو إعادة تعيين كلمة مرور حسابك على Frost. إن لم يكن هذا أنت، تواصل فورًا مع مالك منشأتك.'}).catch(()=>{});
        return send(200,{ok:true});
      }
      if(await partnerRoutes(req,res,url,session,{send,baseUrl}))return;
      if(await clientRoutes(req,res,url,session,{send,baseUrl}))return;
      // Default deny: an /api path must be declared in src/security/route-policy.js (which also drives the merchant gate below
      // and the role floor enforced after workspace resolution). The handlers keep their own checks as a second layer.
      const routePolicy=url.pathname.startsWith('/api/')?classifyRoute(url.pathname):null;
      if(url.pathname.startsWith('/api/') && !routePolicy)fail(404,'المسار غير موجود');
      // Merchant accounts live in the client portal: the legacy workspace API is closed to them regardless of what each handler checks.
      // Platform admins are exempt.
      if(session && routePolicy && !routePolicy.merchantReachable && !isPlatformAdmin(env,session.user) && isMerchantOnly(store.db,session.user.id))fail(403,'MERCHANT_USE_CLIENT_PORTAL');
      if(url.pathname.startsWith('/api/')) {
        authorize(session,['owner','reviewer','operator']);
        if(req.method!=='GET' && req.headers['x-csrf-token']!==session.csrf) fail(403,'رمز حماية الجلسة غير صالح');
      }
      // The one AUTHENTICATED-but-tenant-independent invitation route: accepting a NEW
      // invitation must work even for a multi-membership user whose OTHER memberships are
      // currently ambiguous (TENANT_SELECTION_REQUIRED) — it only ever needs session.user.id,
      // same placement rationale as the Phase 4C-1 workspace-selection routes below.
      const invitationAccept=url.pathname.match(/^\/api\/invitations\/([\w-]+)\/accept$/);
      if(req.method==='POST' && invitationAccept) {
        checkInvitationRateLimit(req.socket.remoteAddress);
        const accepted=acceptInvitation(store.db,invitationAccept[1],session.user.id);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_INVITATION_ACCEPTED',itemId:accepted.tenantId,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},accepted.tenantId);
        return send(200,{workspace:{id:accepted.tenantId,name:accepted.tenantName,role:accepted.role}});
      }
      // Workspace selection (Phase 4C-1) — deliberately handled here, BEFORE the generic
      // `tenantResolutionError` re-throw below, and using ONLY `session.user.id` (never
      // `session.tenantId`, which may not exist at all right now): a multi-membership user
      // with no active selection must still be able to see and choose a workspace, even
      // though every other tenant-scoped route stays correctly blocked until they do.
      if(req.method==='GET' && url.pathname==='/api/workspaces') {
        return send(200,listWorkspacesForUser(store.db,session.user.id,tenantResolutionError?null:session.tenantId));
      }
      if(req.method==='GET' && url.pathname==='/api/workspaces/active') {
        // Part 14 — when there is genuinely no operational workspace, also tell the frontend
        // WHICH real, named workspace(s) this member belongs to that are merely suspended
        // (trial-expired or otherwise) — never silently indistinguishable from "no membership
        // at all" (the same generic NO_WORKSPACE_ACCESS a brand-new signup sees).
        if(tenantResolutionError)return send(tenantResolutionError.status||409,{error:tenantResolutionError.message,workspaces:listWorkspacesForUser(store.db,session.user.id,null),suspendedWorkspaces:listSuspendedWorkspacesForUser(store.db,session.user.id)});
        const active=listWorkspacesForUser(store.db,session.user.id,session.tenantId).find(w=>w.isActive);
        return send(200,active);
      }
      if(req.method==='PUT' && url.pathname==='/api/workspaces/active') {
        const input=await body(req);
        if(typeof input.workspaceId!=='string' || !input.workspaceId) fail(400,'workspaceId مطلوب');
        const workspace=activateWorkspaceForUser(store.db,session.user.id,input.workspaceId);
        auth.setActiveTenant(session.tokenHash,workspace.id);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_ACTIVATED',itemId:workspace.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},workspace.id);
        return send(200,workspace);
      }
      // Platform Identity Phase 4C-5 — Account Settings (Part 36/37: USER identity, never
      // workspace/tenant settings). Deliberately placed here, alongside Workspace Selection,
      // using ONLY `session.user.id` — a multi-membership user with no active workspace
      // selection yet must still be able to manage their own account (Part 57: email identity
      // is global, not scoped to any one workspace).
      if(req.method==='GET' && url.pathname==='/api/account') {
        return send(200,{...getUserIdentity(store.db,session.user.id),platformMail:platformMailStatus(env).status});
      }
      if(req.method==='POST' && url.pathname==='/api/account/email') {
        checkEmailVerificationRateLimit(req.socket.remoteAddress);
        const input=await body(req);
        const hadVerifiedEmailBefore=!!getUserIdentity(store.db,session.user.id)?.emailVerifiedAt;
        const {token,normalizedEmail}=requestEmailChange(store.db,session.user.id,input.email);
        const verifyUrl=`${baseUrl}/app#verify-email/${token}`;
        const locale=session.user.preferredLocale||'ar';
        const delivery=await sendVerificationEmail({db:store.db,env,fetcher},{to:normalizedEmail,locale,verifyUrl});
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:hadVerifiedEmailBefore?'USER_EMAIL_CHANGED':'USER_EMAIL_ADDED',itemId:session.user.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});
        if(delivery.delivered)recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'EMAIL_VERIFICATION_SENT',itemId:session.user.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});
        return send(200,{pendingEmail:normalizedEmail,delivered:delivery.delivered,errorCode:delivery.errorCode||null});
      }
      if(req.method==='POST' && url.pathname==='/api/account/email/resend-verification') {
        checkEmailVerificationRateLimit(req.socket.remoteAddress);
        const {token,normalizedEmail}=resendEmailVerification(store.db,session.user.id);
        const verifyUrl=`${baseUrl}/app#verify-email/${token}`;
        const locale=session.user.preferredLocale||'ar';
        const delivery=await sendVerificationEmail({db:store.db,env,fetcher},{to:normalizedEmail,locale,verifyUrl});
        if(delivery.delivered)recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'EMAIL_VERIFICATION_SENT',itemId:session.user.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});
        return send(200,{pendingEmail:normalizedEmail,delivered:delivery.delivered,errorCode:delivery.errorCode||null});
      }
      // A cheap, read-only check the frontend uses to decide whether to show the Create
      // Workspace form at all, and why not if not — never the authority itself (the real
      // enforcement is `assertCanSelfCreateWorkspace`, called again inside the POST below).
      if(req.method==='GET' && url.pathname==='/api/workspaces/eligibility') {
        const policy=selfServicePolicy(env);
        const ownedCount=countSelfCreatedWorkspaces(store.db,session.user.id);
        return send(200,{allowed:policy.allowed,emailVerified:!!session.user.emailVerifiedAt,ownedCount,maxOwnedWorkspaces:policy.maxOwnedWorkspaces,trialDays:policy.trialDays});
      }
      // Multi-Tenant Phase 4C-6 (Part 10/11) — New Company / Trial Workspace creation. Placed
      // here, tenant-independent, alongside the Phase 4C-1 workspace-selection routes and the
      // Phase 4C-5 account routes above: creating the FIRST tenant for a user obviously cannot
      // require one to already be resolved. Uses ONLY `session.user.id` — never a client-
      // supplied owner/tenant id (Part 10/69/70: the body accepts only `companyName`, `slug`,
      // `defaultLocale`, `timezone`).
      if(req.method==='POST' && url.pathname==='/api/workspaces') {
        if(workspaceCreationInFlight.has(session.user.id))fail(409,'طلب إنشاء منشأة آخر قيد التنفيذ لهذا الحساب بالفعل');
        workspaceCreationInFlight.add(session.user.id);
        try {
          assertCanSelfCreateWorkspace(store.db,env,session.user);
          checkWorkspaceCreationIpLimit(env,req.socket.remoteAddress); // Part 4 — per-IP daily cap, distinct from the per-user permanent cap above
          checkTotalTrialWorkspacesLimit(store.db,env); // Part 4 — platform-wide TRIAL ceiling for the pilot
          const input=await body(req);
          if(captchaRequiredFor(env,'workspaceCreation')) {
            const captcha=await verifyBotProtection({env,fetcher},input.captchaToken,req.socket.remoteAddress);
            if(!captcha.ok)fail(400,captcha.errorCode);
          }
          let created;
          try { created=bootstrapWorkspaceForOwner(store.db,env,{companyName:input.companyName,slug:input.slug,defaultLocale:input.defaultLocale,timezone:input.timezone},session.user.id); }
          catch(error) { if(error.code==='WORKSPACE_SLUG_TAKEN')return send(409,{error:error.message,suggestion:error.suggestion});throw error; }
          const {tenantId,slug,trialExpiresAt}=created;
          // Part 71 — activate the session's workspace only AFTER the creation transaction has
          // already committed; a failure here never rolls back the (already real, already
          // valid) tenant — the owner can still reach it from the workspace switcher.
          auth.setActiveTenant(session.tokenHash,tenantId);
          const now=new Date().toISOString();
          recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_CREATED',itemId:tenantId,actorId:session.user.id,actorName:session.user.name,at:now},tenantId);
          recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_TRIAL_STARTED',itemId:tenantId,actorId:session.user.id,actorName:session.user.name,at:now},tenantId);
          return send(201,{id:tenantId,slug,trialExpiresAt});
        } finally { workspaceCreationInFlight.delete(session.user.id); }
      }
      // Multi-Tenant Phase 4C-7 (Part 19-27) — Platform Admin. Deliberately tenant-independent
      // (same placement rationale as every route above this line): a platform admin inspecting
      // or acting on a tenant they may not even be a member of obviously cannot go through
      // per-session tenant resolution. `requirePlatformAdmin` is the ONE real gate — never a
      // tenant owner's own role, however senior (Part 20/58).
      if(url.pathname.startsWith('/api/platform/'))requirePlatformAdmin(env,session);
      if(url.pathname==='/api/platform/overview' && req.method==='GET') {
        requirePlatformAdmin(env,session);
        // Phase 7B — Platform Command Center (spec Part 24-28): scheduler.running() is the
        // SAME real flag /api/frost/status already exposes per-tenant — surfaced here too so
        // "هل الـscheduler شغال؟" has a real, non-fabricated answer at the platform level.
        return send(200,{...buildPlatformOverview(store.db,env),schedulerRunning:scheduler.running()});
      }
      if(url.pathname==='/api/platform/webhooks/dead-letter' && req.method==='GET') {
        requirePlatformAdmin(env,session);
        return send(200,listPlatformDeadLetterWebhooks(store.db,{limit:50}));
      }
      if(url.pathname==='/api/platform/tenants/unhealthy-integrations' && req.method==='GET') {
        requirePlatformAdmin(env,session);
        return send(200,listTenantsWithUnhealthyIntegrations(store.db,env));
      }
      // Phase 7C — Platform Command Center Chat (spec Part 37-42). Tenant-independent by
      // construction (same rationale as every Platform Admin route in this file): gated
      // exclusively by requirePlatformAdmin, never a tenant role however senior.
      if(url.pathname==='/api/platform/frost/messages') {
        requirePlatformAdmin(env,session);
        if(req.method==='GET')return send(200,listPlatformFrostMessages(store.db,{}));
        if(req.method==='POST') {
          checkLlmRateLimit(session.user.id);
          const input=await body(req);
          const result=await sendPlatformFrostMessage({db:store.db,env,fetcher,schedulerRunning:scheduler.running(),actor:session.user,text:input.text});
          return send(201,result);
        }
      }
      if(url.pathname==='/api/platform/tenants' && req.method==='GET') {
        requirePlatformAdmin(env,session);
        return send(200,listTenantDirectory(store.db,env));
      }
      const platformTenantDetail=url.pathname.match(/^\/api\/platform\/tenants\/([\w-]+)$/);
      if(platformTenantDetail && req.method==='GET') {
        requirePlatformAdmin(env,session);
        return send(200,getTenantDetail(store.db,env,platformTenantDetail[1]));
      }
      const platformSuspend=url.pathname.match(/^\/api\/platform\/tenants\/([\w-]+)\/suspend$/);
      if(platformSuspend && req.method==='POST') {
        requirePlatformAdmin(env,session);
        suspendTenantByPlatform(store.db,platformSuspend[1],session.user,(await body(req)).reason);
        return send(200,{ok:true});
      }
      const platformReactivate=url.pathname.match(/^\/api\/platform\/tenants\/([\w-]+)\/reactivate$/);
      if(platformReactivate && req.method==='POST') {
        requirePlatformAdmin(env,session);
        reactivateTenantByPlatform(store.db,platformReactivate[1],session.user);
        return send(200,{ok:true});
      }
      const platformExtendTrial=url.pathname.match(/^\/api\/platform\/tenants\/([\w-]+)\/extend-trial$/);
      if(platformExtendTrial && req.method==='POST') {
        requirePlatformAdmin(env,session);
        const input=await body(req);
        const tenant=extendTrialByPlatform(store.db,platformExtendTrial[1],{days:Number(input.days)},session.user);
        return send(200,{id:tenant.id,status:tenant.status,trialExpiresAt:tenant.trialExpiresAt});
      }
      // Phase 6H, Part 37-42 — Per-tenant Custom Connector Limit Override.
      const platformCustomConnectorLimit=url.pathname.match(/^\/api\/platform\/tenants\/([\w-]+)\/custom-connector-limit$/);
      if(platformCustomConnectorLimit && req.method==='POST') {
        requirePlatformAdmin(env,session);
        const input=await body(req);
        const limit=input.limit===null||input.limit===''||input.limit===undefined?null:Number(input.limit);
        const result=setCustomConnectorLimitByPlatform(store.db,env,platformCustomConnectorLimit[1],{limit},session.user);
        return send(200,result);
      }
      // Universal Integration Platform (Phase 6D) — the Integration Builder's HTTP surface.
      // Tenant-independent, same placement rationale as the Platform Admin routes just above:
      // a platform admin authoring a Connector Definition is never acting within any one
      // tenant's own workspace. Every mutation below delegates STRAIGHT to builder.js, which
      // enforces its OWN Platform Admin check on every call (never a tenant role, however
      // senior — Part 25/100/126/127) — so `session.user` is passed through as the actor and
      // the real 403 comes from the same allowlist as every other Platform Admin action.
      if(url.pathname==='/api/platform/connectors' && req.method==='GET') {
        return send(200,listConnectorsForBuilder(store.db,env,session.user));
      }
      // The Integration Builder's Capabilities tab picks from this REAL, canonical list —
      // never a freehand text field a Platform Admin could typo into a rejected publish.
      if(url.pathname==='/api/platform/capabilities' && req.method==='GET') {
        requirePlatformAdmin(env,session);
        return send(200,CANONICAL_CAPABILITIES);
      }
      // Item 20 — Mapping Preview: the EXACT canonical mapper (Phase 6C) a real action/webhook
      // uses, run against a Platform-Admin-supplied sample payload — never a second, separate
      // "preview-only" mapper, and never any real network call or persistence.
      if(url.pathname==='/api/platform/mapping-preview' && req.method==='POST') {
        requirePlatformAdmin(env,session);
        const input=await body(req);
        try {
         const result=applyMapping(input.mapping,input.samplePayload);
         return send(200,{ok:true,result});
        } catch(error) {
         return send(200,{ok:false,errorCode:error instanceof MappingError?error.code:'MAPPING_ERROR',message:error.message});
        }
      }
      if(url.pathname==='/api/platform/connectors' && req.method==='POST') {
        const input=await body(req);
        const created=createDraftConnector(store.db,env,session.user,input);
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTOR_DRAFT_CREATED',itemId:created.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});
        return send(201,created);
      }
      const platformConnectorItem=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)$/);
      if(platformConnectorItem && req.method==='GET') {
        return send(200,getConnectorForBuilder(store.db,env,session.user,platformConnectorItem[1]));
      }
      if(platformConnectorItem && req.method==='PATCH') {
        const updated=updateDraftConnector(store.db,env,session.user,platformConnectorItem[1],await body(req));
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTOR_DRAFT_UPDATED',itemId:updated.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});
        return send(200,updated);
      }
      const platformConnectorValidate=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/validate$/);
      if(platformConnectorValidate && req.method==='POST') {
        return send(200,validateConnectorDraft(store.db,env,session.user,platformConnectorValidate[1]));
      }
      const platformConnectorPublish=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/publish$/);
      if(platformConnectorPublish && req.method==='POST') {
        const published=publishConnector(store.db,env,session.user,platformConnectorPublish[1]);
        const now=new Date().toISOString();
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTOR_PUBLISHED',itemId:published.id,actorId:session.user.id,actorName:session.user.name,at:now});
        // Phase 6G, Part 8 — a distinct, versioning-specific audit event alongside the general
        // one above (every publish, including the first, creates a real new version snapshot).
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTOR_VERSION_PUBLISHED',itemId:published.id,detail:String(published.version),actorId:session.user.id,actorName:session.user.name,at:now});
        return send(200,published);
      }
      const platformConnectorDisable=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/disable$/);
      if(platformConnectorDisable && req.method==='POST') {
        const disabled=disableConnector(store.db,env,session.user,platformConnectorDisable[1]);
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTOR_DISABLED',itemId:disabled.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});
        return send(200,disabled);
      }
      const platformConnectorReactivate=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/reactivate$/);
      if(platformConnectorReactivate && req.method==='POST') {
        const reactivated=reactivateConnector(store.db,env,session.user,platformConnectorReactivate[1]);
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTOR_REACTIVATED',itemId:reactivated.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});
        return send(200,reactivated);
      }
      const platformConnectorDependencies=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/dependencies$/);
      if(platformConnectorDependencies && req.method==='GET') {
        return send(200,getConnectorDependencies(store.db,env,session.user,platformConnectorDependencies[1]));
      }
      const platformConnectorActions=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/actions$/);
      if(platformConnectorActions && req.method==='POST') {
        return send(201,upsertActionForConnector(store.db,env,session.user,platformConnectorActions[1],await body(req)));
      }
      const platformConnectorActionItem=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/actions\/([\w-]+)$/);
      if(platformConnectorActionItem && req.method==='DELETE') {
        deleteActionForConnector(store.db,env,session.user,platformConnectorActionItem[1],platformConnectorActionItem[2]);
        return send(200,{ok:true});
      }
      const platformConnectorTriggers=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/triggers$/);
      if(platformConnectorTriggers && req.method==='POST') {
        return send(201,upsertTriggerForConnector(store.db,env,session.user,platformConnectorTriggers[1],await body(req)));
      }
      const platformConnectorTriggerItem=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/triggers\/([\w-]+)$/);
      if(platformConnectorTriggerItem && req.method==='DELETE') {
        deleteTriggerForConnector(store.db,env,session.user,platformConnectorTriggerItem[1],platformConnectorTriggerItem[2]);
        return send(200,{ok:true});
      }
      // Phase 6F, Part 7/23/24 — Clone: a brand-new DRAFT, never credentials (a definition
      // never holds one to begin with).
      const platformConnectorClone=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/clone$/);
      if(platformConnectorClone && req.method==='POST') {
        const input=await body(req);
        if(typeof input.slug!=='string'||!input.slug)fail(400,'slug مطلوب للنسخة الجديدة');
        const cloned=cloneConnectorDefinition(store.db,env,session.user,platformConnectorClone[1],input.slug);
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTOR_CLONED',itemId:cloned.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});
        return send(201,cloned);
      }
      // Part 8/22 — Export: safe, portable JSON (declarative shape only, verified secret-free
      // by construction — see exportConnectorDefinition's own doc comment).
      const platformConnectorExport=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/export$/);
      if(platformConnectorExport && req.method==='GET') {
        return send(200,exportConnectorDefinition(store.db,env,session.user,platformConnectorExport[1]));
      }
      // Part 9/22 — Import: the imported JSON is NEVER trusted directly; it re-enters through
      // the exact same validated Builder entry points a manual creation would (see
      // importConnectorDefinition's own doc comment) — SSRF/capability/event-type checks apply
      // exactly as they would to a hand-typed connector.
      if(url.pathname==='/api/platform/connectors/import' && req.method==='POST') {
        const input=await body(req);
        const imported=importConnectorDefinition(store.db,env,session.user,input.definition,{slug:input.slug});
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTOR_IMPORTED',itemId:imported.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});
        return send(201,imported);
      }
      // Phase 6G, Part 2/3/4 — Versioning UI backend surface.
      const platformConnectorVersions=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/versions$/);
      if(platformConnectorVersions && req.method==='GET') {
        return send(200,listConnectorVersions(store.db,env,session.user,platformConnectorVersions[1]));
      }
      const platformConnectorVersionDiff=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/versions\/diff$/);
      if(platformConnectorVersionDiff && req.method==='GET') {
        return send(200,getVersionDiff(store.db,env,session.user,platformConnectorVersionDiff[1],url.searchParams.get('from'),url.searchParams.get('to')));
      }
      const platformConnectorVersionDraft=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/versions\/draft$/);
      if(platformConnectorVersionDraft && req.method==='POST') {
        const drafted=createDraftVersion(store.db,env,session.user,platformConnectorVersionDraft[1]);
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTOR_VERSION_CREATED',itemId:drafted.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});
        return send(200,drafted);
      }
      // Phase 6H, Part 1 (implicit) — discard an in-progress draft workspace without publishing.
      const platformConnectorVersionDiscard=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/versions\/discard$/);
      if(platformConnectorVersionDiscard && req.method==='POST') {
        const discarded=discardDraftVersion(store.db,env,session.user,platformConnectorVersionDiscard[1]);
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTOR_DRAFT_VERSION_DISCARDED',itemId:discarded.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});
        return send(200,discarded);
      }
      // Phase 6G, Part 41 — Connector Analytics (Platform Admin, cross-tenant).
      const platformConnectorAnalytics=url.pathname.match(/^\/api\/platform\/connectors\/([\w-]+)\/analytics$/);
      if(platformConnectorAnalytics && req.method==='GET') {
        requirePlatformAdmin(env,session);
        const definition=getConnectorForBuilder(store.db,env,session.user,platformConnectorAnalytics[1]);
        return send(200,getConnectorAnalytics(store.db,definition.slug,url.searchParams.get('window')||'7d',{tenantId:url.searchParams.get('tenantId')||null}));
      }
      // Phase 6G, Part 28-38 — Tenant Custom Connector Governance: Platform Admin's review queue.
      if(url.pathname==='/api/platform/custom-connectors/pending' && req.method==='GET') {
        return send(200,listPendingTenantConnectors(store.db,env,session.user));
      }
      const platformCustomConnectorReview=url.pathname.match(/^\/api\/platform\/custom-connectors\/([\w-]+)\/review$/);
      if(platformCustomConnectorReview && req.method==='POST') {
        const input=await body(req);
        const reviewed=reviewTenantConnector(store.db,env,session.user,platformCustomConnectorReview[1],{decision:input.decision,notes:input.notes});
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'TENANT_CONNECTOR_REVIEWED',itemId:reviewed.id,detail:input.decision,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});
        return send(200,reviewed);
      }
      // Phase 6H, Part 6-9 — Bulk Connection Version Migration (Platform Admin only, Part 46).
      if(url.pathname==='/api/platform/bulk/version-migration/preview' && req.method==='GET') {
        return send(200,previewBulkVersionMigration(store.db,env,session.user,{connectorSlug:url.searchParams.get('connectorSlug'),fromVersion:url.searchParams.get('fromVersion'),toVersion:url.searchParams.get('toVersion')}));
      }
      if(url.pathname==='/api/platform/bulk/version-migration' && req.method==='POST') {
        const input=await body(req);
        const result=await bulkMigrateConnections({db:store.db,env,fetcher,actorUser:session.user,connectorSlug:input.connectorSlug,fromVersion:input.fromVersion,toVersion:input.toVersion,connectionIds:input.connectionIds});
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'BULK_VERSION_MIGRATION_EXECUTED',itemId:result.operationId,detail:JSON.stringify(result.summary),actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});
        return send(200,result);
      }
      const bulkVersionRollback=url.pathname.match(/^\/api\/platform\/bulk\/version-migration\/([\w-]+)\/rollback$/);
      if(bulkVersionRollback && req.method==='POST') {
        const result=await bulkRollbackOperation({db:store.db,env,fetcher,actorUser:session.user,operationId:bulkVersionRollback[1]});
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'BULK_VERSION_MIGRATION_ROLLED_BACK',itemId:result.operationId,detail:JSON.stringify(result.summary),actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});
        return send(200,result);
      }
      if(url.pathname==='/api/platform/bulk/operations' && req.method==='GET') {
        return send(200,listBulkOperations(store.db,env,session.user,{type:url.searchParams.get('type')||undefined,limit:Number(url.searchParams.get('limit'))||20}));
      }
      const bulkOperationItem=url.pathname.match(/^\/api\/platform\/bulk\/operations\/([\w-]+)$/);
      if(bulkOperationItem && req.method==='GET') {
        return send(200,getBulkOperation(store.db,env,session.user,bulkOperationItem[1]));
      }
      // Phase 6H, Part 10-12 — Bulk Webhook Reprocess (Platform Admin only, Part 46).
      if(url.pathname==='/api/platform/bulk/webhook-reprocess/preview' && req.method==='GET') {
        return send(200,previewBulkWebhookReprocess(store.db,env,session.user,{connectorSlug:url.searchParams.get('connectorSlug'),tenantId:url.searchParams.get('tenantId')||null,fromDate:url.searchParams.get('fromDate')||null,toDate:url.searchParams.get('toDate')||null,errorCode:url.searchParams.get('errorCode')||null}));
      }
      if(url.pathname==='/api/platform/bulk/webhook-reprocess' && req.method==='POST') {
        const input=await body(req);
        const result=await bulkReprocessWebhookEvents({db:store.db,env,eventBus,actorUser:session.user,connectorSlug:input.connectorSlug,tenantId:input.tenantId||null,fromDate:input.fromDate||null,toDate:input.toDate||null,errorCode:input.errorCode||null,eventIds:input.eventIds||null});
        recordPlatformAudit(store.db,{id:crypto.randomUUID(),action:'BULK_WEBHOOK_REPROCESS_EXECUTED',itemId:result.operationId,detail:JSON.stringify(result.summary),actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});
        return send(200,result);
      }
      // Phase 6H, Part 46-48 — Platform Operations visibility: real, live, cross-tenant Dead
      // Letter / Pending Retry lists (Automatic Webhook Retry, Part 13-18).
      if(url.pathname==='/api/platform/webhooks/dead-letters' && req.method==='GET') {
        return send(200,listDeadLetterEvents(store.db,env,session.user,{limit:Number(url.searchParams.get('limit'))||50}));
      }
      if(url.pathname==='/api/platform/webhooks/pending-retries' && req.method==='GET') {
        return send(200,listPendingRetries(store.db,env,session.user,{limit:Number(url.searchParams.get('limit'))||50}));
      }
      // Every OTHER /api/ route requires a successfully resolved tenant — unchanged behavior
      // from before this phase (Part B Case 4: TENANT_SELECTION_REQUIRED remains the only
      // safe outcome for an unresolved multi-membership session on any non-workspace route).
      if(url.pathname.startsWith('/api/') && tenantResolutionError) throw tenantResolutionError;
      if(routePolicy?.access==='platform_operator')requirePlatformOperator(store.db,env,session);
      // Workspace Invitations + Member Management (Phase 4C-3) — owner-only throughout,
      // matching the exact same bar /api/users already sets for every account-identity-
      // adjacent action in this codebase. `session.tenantId` (server-resolved above, never a
      // client value) scopes every one of these — a membership/invitation id from another
      // tenant simply never matches (tenancy.js/invitations.js's own tenant_id=? filters),
      // the same "wrong tenant is indistinguishable from nonexistent" 404 every other
      // tenant-scoped getter in this app already follows.
      if(url.pathname==='/api/workspaces/invitations') {
        authorize(session,['owner']);
        if(req.method==='GET')return send(200,listInvitations(store.db,session.tenantId));
        if(req.method==='POST') {
          const input=await body(req);
          const {invitation,token}=createInvitation(store.db,session.tenantId,{email:input.email,role:input.role},session.user.id);
          recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_INVITATION_CREATED',itemId:invitation.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
          // Phase 4C-5 (Part 33) — best-effort platform-mail delivery of the accept link. The
          // raw token is STILL returned to the owner regardless of delivery outcome (Part 33:
          // "يمكن Owner أيضًا Copy Link إذا policy تسمح") — never persisted plaintext
          // (invitations.js stores only its hash), never returned by the list endpoint, never
          // logged (Part 32/70). The frontend must not claim "sent" unless `delivered:true`.
          const tenant=getTenant(store.db,session.tenantId);
          const acceptUrl=`${baseUrl}/app#invite/${token}`;
          const delivery=await sendInvitationEmail({db:store.db,env,fetcher},{to:invitation.email,locale:session.user.preferredLocale||'ar',workspaceName:tenant.name,acceptUrl,role:invitation.role});
          return send(201,{...invitation,token,delivered:delivery.delivered});
        }
      }
      const invitationResend=url.pathname.match(/^\/api\/workspaces\/invitations\/([\w-]+)\/resend$/);
      if(req.method==='POST' && invitationResend) {
        authorize(session,['owner']);
        const {invitation,token}=resendInvitation(store.db,session.tenantId,invitationResend[1]);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_INVITATION_RESENT',itemId:invitation.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        const tenant=getTenant(store.db,session.tenantId);
        const acceptUrl=`${baseUrl}/app#invite/${token}`;
        const delivery=await sendInvitationEmail({db:store.db,env,fetcher},{to:invitation.email,locale:session.user.preferredLocale||'ar',workspaceName:tenant.name,acceptUrl,role:invitation.role});
        return send(200,{...invitation,token,delivered:delivery.delivered});
      }
      const invitationRevoke=url.pathname.match(/^\/api\/workspaces\/invitations\/([\w-]+)\/revoke$/);
      if(req.method==='POST' && invitationRevoke) {
        authorize(session,['owner']);
        const invitation=revokeInvitation(store.db,session.tenantId,invitationRevoke[1]);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_INVITATION_REVOKED',itemId:invitation.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,invitation);
      }
      if(req.method==='GET' && url.pathname==='/api/workspaces/members') {
        authorize(session,['owner']);
        return send(200,listActiveMembers(store.db,session.tenantId));
      }
      const memberItem=url.pathname.match(/^\/api\/workspaces\/members\/([\w-]+)$/);
      if(memberItem) {
        authorize(session,['owner']);
        if(req.method==='PATCH') {
          const input=await body(req);
          let updated=getMembership(store.db,session.tenantId,memberItem[1]);
          if(!updated)fail(404,'العضوية غير موجودة');
          if(input.role!==undefined && input.role!==updated.role) {
            updated=updateMembershipRole(store.db,session.tenantId,memberItem[1],input.role);
            recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_MEMBER_ROLE_CHANGED',itemId:memberItem[1],detail:input.role,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
          }
          if(input.status!==undefined && input.status!==updated.status) {
            updated=updateMembershipStatus(store.db,session.tenantId,memberItem[1],input.status);
            recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_MEMBER_STATUS_CHANGED',itemId:memberItem[1],detail:input.status,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
          }
          return send(200,updated);
        }
        if(req.method==='DELETE') {
          const updated=updateMembershipStatus(store.db,session.tenantId,memberItem[1],'removed');
          recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_MEMBER_REMOVED',itemId:memberItem[1],actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
          return send(200,updated);
        }
      }
      if(req.method==='POST' && url.pathname==='/api/preferences/locale') {
        const input=await body(req);
        auth.setPreferredLocale(session.user.id,input.locale);
        return send(200,{ok:true});
      }
      if(url.pathname==='/api/users') {
        authorize(session,['owner']);
        // The user directory is platform-global: a workspace owner sees the accounts of THEIR workspace only, and creating a bare
        // account is a platform-operator action (workspaces grow through invitations, see /api/workspaces/invitations).
        if(req.method==='GET') return send(200,isPlatformOperator(store.db,env,session)?auth.list():listUsersForTenant(store.db,session.tenantId));
        if(req.method==='POST') {
          requirePlatformOperator(store.db,env,session);
          const created=auth.createUser(await body(req));
          recordAudit(store.db,{id:crypto.randomUUID(),action:'USER_CREATED',itemId:created.id,actorId:session.user.id,actorName:session.user.name,actorRole:session.user.role,at:new Date().toISOString()},session.tenantId);
          return send(201,created);
        }
      }
      if(req.method==='GET' && url.pathname==='/api/team/dashboard') {
        authorize(session,['owner']);
        return send(200,buildTeamDashboard(store.db,{auditEntries:listAuditLog(store.db,{tenantId:session.tenantId}),tenantId:isPlatformOperator(store.db,env,session)?null:session.tenantId}));
      }
      const userAction=url.pathname.match(/^\/api\/users\/([\w-]+)\/(role|suspend|reactivate|remove|reset-access|revoke-sessions)$/);
      if(req.method==='POST' && userAction) {
        authorize(session,['owner']);
        const [,id,action]=userAction;
        if(!auth.get(id))fail(404,'العضو غير موجود');
        // Account-level actions reach every workspace the person belongs to: outside the operator's own workspace they are
        // limited to accounts that belong to this workspace alone, and a wrong-workspace id is indistinguishable from a missing one.
        if(!isPlatformOperator(store.db,env,session)&&!canManageUserFromTenant(store.db,session.tenantId,id,{isPlatformAdminUser:isPlatformAdmin(env,auth.get(id))}))fail(404,'العضو غير موجود');
        const input=await body(req);
        let auditAction,itemName=auth.get(id).name;
        if(action==='role') {
          if(!['owner','reviewer','operator'].includes(input.role))fail(400,'دور غير صالح');
          assertRoleChangeAllowed(store.db,id,input.role);
          const held=store.db.prepare("SELECT id FROM tenant_memberships WHERE tenant_id=? AND user_id=? AND status='active'").get(session.tenantId,id);
          if(held)updateMembershipRole(store.db,session.tenantId,held.id,input.role); // the workspace role is what authorizes; keep it authoritative
          auth.setRole(id,input.role);auditAction='USER_ROLE_CHANGED';
        } else if(action==='suspend') {
          assertDeactivationAllowed(store.db,id);
          auth.setStatus(id,'suspended');auditAction='USER_SUSPENDED';
        } else if(action==='reactivate') {
          auth.setStatus(id,'active');auditAction='USER_REACTIVATED';
        } else if(action==='remove') {
          assertDeactivationAllowed(store.db,id);
          auth.removeUser(id);auditAction='USER_REMOVED';
        } else if(action==='reset-access') {
          auth.resetPassword(id,input.password);auditAction='USER_ACCESS_RESET';
        } else if(action==='revoke-sessions') {
          auth.revokeSessions(id);auditAction='USER_SESSIONS_REVOKED';
        }
        recordAudit(store.db,{id:crypto.randomUUID(),action:auditAction,itemId:id,itemName,actorId:session.user.id,actorName:session.user.name,actorRole:session.user.role,at:new Date().toISOString()},session.tenantId);
        return send(200,action==='remove'?{ok:true}:auth.get(id)||{ok:true});
      }
      if(req.method==='GET' && url.pathname==='/api/agents') {
        const autonomy=currentAutonomy(store.db,session.tenantId);
        const integrations=integrationStatus(env,store.db,session.tenantId);
        const integrationNames={whatsapp:'واتساب',meta:'ميتا (Instagram/Facebook)',x:'X',linkedin:'لينكدإن',microsoft365:'Microsoft 365',canva:'Canva',salla_webhooks:'ويبهوكس سلة'};
        return send(200,agentDefinitions.map(agent=>{
          const registryRow=getAgent(store.db,agent.id);
          // Per-agent, not global: an agent pinned to a provider/model override (registry
          // row) is only WAITING_LLM if THAT provider is unconfigured, even if the account
          // default provider is configured (or vice versa).
          const llm=providerStatus(env,{provider:registryRow?.provider,model:registryRow?.model});
          const required=AGENT_INTEGRATIONS[agent.id]||[];
          const missing=required.filter(key=>!integrations[key]?.configured);
          const runtimeStatus=!registryRow?.enabled?'DISABLED':!llm.configured?'WAITING_LLM':missing.length?'WAITING_INTEGRATION':'ONLINE';
          const runtimeLabel=runtimeStatus==='DISABLED'?'معطّل':runtimeStatus==='WAITING_LLM'?'بانتظار إعداد مزود الذكاء الاصطناعي':runtimeStatus==='WAITING_INTEGRATION'?`جاهز داخليًا — بانتظار: ${missing.map(k=>integrationNames[k]||k).join('، ')}`:'جاهز للعمل داخليًا';
          const recentRuns=listRuns(store.db,{agentId:agent.id,limit:10},session.tenantId);
          return {...agent,level:autonomy[agent.id].level,autonomyVersion:autonomy[agent.id].version,autonomyUpdatedAt:autonomy[agent.id].at,autonomyUpdatedBy:autonomy[agent.id].actorName,autonomyReason:autonomy[agent.id].reason,
           runtimeStatus,runtimeLabel,enabled:!!registryRow?.enabled,requiredIntegrations:required,missingIntegrations:missing,
           modelConfig:registryRow?{provider:registryRow.provider,model:registryRow.model,temperature:registryRow.temperature,maxTokens:registryRow.max_tokens}:null,
           runsTotal:recentRuns.length,lastRunAt:recentRuns[0]?.started_at||null,lastRunStatus:recentRuns[0]?.status||null};
        }));
      }
      if(req.method==='POST' && url.pathname==='/api/agents/reseed') {authorize(session,['owner']);requirePlatformOperator(store.db,env,session);return send(200,seedRegistry(store.db));}
      const agentModelConfig=url.pathname.match(/^\/api\/agents\/([\w-]+)\/model-config$/);
      if(req.method==='POST' && agentModelConfig) {
        authorize(session,['owner']);
        requirePlatformOperator(store.db,env,session); // the registry row is shared by every workspace (a workspace overrides via /config)
        const input=await body(req);
        const row=setModelConfig(store.db,agentModelConfig[1],{provider:input.provider,model:input.model,temperature:input.temperature,maxTokens:input.maxTokens});
        if(!row)fail(404,'وكيل غير موجود');
        return send(200,row);
      }
      if(req.method==='GET' && url.pathname==='/api/agents/cost-summary') {
        authorize(session,['owner']);
        const since=url.searchParams.get('since')||new Date(Date.now()-30*86400000).toISOString();
        const rows=store.db.prepare('SELECT agent_id,provider,model,COUNT(*) runs,SUM(tokens_input) tokens_input,SUM(tokens_output) tokens_output,SUM(estimated_cost) estimated_cost,SUM(used_fallback) fallback_runs FROM agent_runs WHERE started_at>=? AND (? IS NULL OR tenant_id=?) GROUP BY agent_id,provider,model ORDER BY estimated_cost DESC').all(since,...(()=>{const scope=isPlatformOperator(store.db,env,session)?null:session.tenantId;return [scope,scope];})());
        return send(200,{since,provider:providerStatus(env),rows});
      }
      const agentEnable=url.pathname.match(/^\/api\/agents\/([\w-]+)\/enabled$/);
      if(agentEnable) {
        authorize(session,['owner']);
        if(req.method==='POST'){
          const input=await body(req);
          // Only the operator changes the shared registry default; a workspace toggles its own tenant config below.
          const row=isPlatformOperator(store.db,env,session)?setEnabled(store.db,agentEnable[1],!!input.enabled):getAgent(store.db,agentEnable[1]);
          if(!row)fail(404,'وكيل غير موجود');
          // Multi-Tenant Phase 4B: `agent_registry.enabled` is now only the legacy default a
          // brand-new tenant's config is seeded from (Part 49) — the tenant-scoped
          // TenantAgentConfig is what execution actually reads (runtime.js). Kept in sync
          // here so this pre-existing route keeps working exactly as before for the calling
          // tenant, rather than silently becoming a no-op once a config row exists.
          updateTenantAgentConfig(store.db,session.tenantId,agentEnable[1],{enabled:!!input.enabled});
          return send(200,row);
        }
      }
      const agentHealth=url.pathname.match(/^\/api\/agents\/([\w-]+)\/health$/);
      if(req.method==='GET' && agentHealth)return send(200,promotionEligibility(store.db,agentHealth[1],session.tenantId));
      const agentRuns=url.pathname.match(/^\/api\/agents\/([\w-]+)\/runs$/);
      if(req.method==='GET' && agentRuns)return send(200,listRuns(store.db,{agentId:agentRuns[1],limit:50},session.tenantId));
      const agentRunTrigger=url.pathname.match(/^\/api\/agents\/([\w-]+)\/run$/);
      if(req.method==='POST' && agentRunTrigger) {
        authorize(session,['owner','operator']);
        checkLlmRateLimit(session.user.id);
        const input=await body(req);
        if(typeof input.scenario!=='string'||!input.scenario.trim()||input.scenario.length>4000)fail(400,'أدخل سيناريو الاختبار (حتى 4000 حرف)');
        return send(200,await agentRuntime.run(agentRunTrigger[1],{triggerType:'TEST',input:{scenario:input.scenario.trim(),current_datetime:new Date().toISOString(),timezone:'Asia/Riyadh'},user:session.user,tenantId:session.tenantId}));
      }
      const runDetail=url.pathname.match(/^\/api\/agents\/runs\/([\w-]+)$/);
      if(req.method==='GET' && runDetail) {
        const run=getRun(store.db,runDetail[1],session.tenantId);
        if(!run)fail(404,'التشغيلة غير موجودة');
        // Phase 7B — Multi-Agent trace (spec Part 47-48): real child runs this run delegated to
        // (Frost Commander's delegate_to_agent tool sets parent_run_id — see runtime.js), each
        // with its OWN real status/tool calls, never a fabricated tree.
        const childRuns=listChildRuns(store.db,runDetail[1],session.tenantId).map(child=>({...child,toolCalls:listToolCalls(store.db,child.id)}));
        return send(200,{...run,toolCalls:listToolCalls(store.db,runDetail[1]),childRuns});
      }
      // ---------------------------------------------------------------------------------
      // Multi-Tenant Phase 4B — Agent Tool Assignment + Tool-to-Connection Mapping + Agent
      // Readiness backend API. Read routes (config/tools/readiness) are owner+operator, same
      // bar as every other agent-status read in this file; mutations (config PATCH, tool
      // PUT/DELETE, workspace AI/safety-ceiling) are owner-only, matching credential-adjacent
      // routes elsewhere. Every response is built from real service calls — never a stored
      // "looks ready" flag (Part 31) — and never includes a vault secret (Part 21/75).
      // ---------------------------------------------------------------------------------
      const agentConfigRoute=url.pathname.match(/^\/api\/agents\/([\w-]+)\/config$/);
      if(agentConfigRoute) {
        const agentId=agentConfigRoute[1];
        if(req.method==='GET') {
          authorize(session,['owner','operator']);
          if(!getAgent(store.db,agentId))fail(404,'وكيل غير موجود');
          const config=getTenantAgentConfig(store.db,session.tenantId,agentId);
          return send(200,config||{tenantId:session.tenantId,agentId,enabled:true,aiConnectionId:null,model:null,temperature:null,maxTokens:null,timeoutMs:null,approvalPolicy:null});
        }
        if(req.method==='PATCH') {
          authorize(session,['owner']);
          const input=await body(req);
          const before=getTenantAgentConfig(store.db,session.tenantId,agentId);
          const updated=updateTenantAgentConfig(store.db,session.tenantId,agentId,input);
          const now=new Date().toISOString();
          if(input.aiConnectionId!==undefined && input.aiConnectionId!==before?.aiConnectionId)
           recordAudit(store.db,{id:crypto.randomUUID(),action:'AGENT_AI_CONNECTION_CHANGED',itemId:agentId,connectionId:input.aiConnectionId,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
          if(input.model!==undefined && input.model!==before?.model)
           recordAudit(store.db,{id:crypto.randomUUID(),action:'AGENT_MODEL_CHANGED',itemId:agentId,model:input.model,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
          return send(200,updated);
        }
      }
      const agentToolsRoute=url.pathname.match(/^\/api\/agents\/([\w-]+)\/tools$/);
      if(req.method==='GET' && agentToolsRoute) {
        authorize(session,['owner','operator']);
        const agentId=agentToolsRoute[1];
        if(!getAgent(store.db,agentId))fail(404,'وكيل غير موجود');
        const assignments=new Map(listAssignmentsForAgent(store.db,session.tenantId,agentId).map(a=>[a.toolSlug,a]));
        const tools=listToolDefinitions(store.db).filter(t=>!t.allowedAgents||t.allowedAgents.includes(agentId));
        // Phase 4B.1 (Part 10) — each tool's live readiness (READY / CONNECTION_REQUIRED /
        // CONNECTION_UNHEALTHY / CONNECTION_CAPABILITY_MISSING / DISABLED), so a UI can show
        // exactly why a tool isn't usable without a second round-trip — never a credential.
        const readinessBySlug=new Map(evaluateAllToolsReadiness(store.db,env,{tenantId:session.tenantId,agentId}).map(r=>[r.toolSlug,r]));
        return send(200,tools.map(tool=>({...tool,assignment:assignments.get(tool.slug)||null,readiness:readinessBySlug.get(tool.slug)||null})));
      }
      const agentToolItem=url.pathname.match(/^\/api\/agents\/([\w-]+)\/tools\/([\w-]+)$/);
      if(agentToolItem) {
        authorize(session,['owner']);
        const [,agentId,toolSlug]=agentToolItem;
        if(req.method==='PUT') {
          const input=await body(req);
          const before=getToolDefinition(store.db,toolSlug)&&listAssignmentsForAgent(store.db,session.tenantId,agentId).find(a=>a.toolSlug===toolSlug);
          const assignment=upsertAssignment(store.db,session.tenantId,agentId,toolSlug,{enabled:input.enabled,connectionId:input.connectionId,policyOverride:input.policyOverride});
          const now=new Date().toISOString();
          if(input.enabled===false)recordAudit(store.db,{id:crypto.randomUUID(),action:'AGENT_TOOL_DISABLED',itemId:agentId,toolSlug,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
          else if(!before)recordAudit(store.db,{id:crypto.randomUUID(),action:'AGENT_TOOL_ASSIGNED',itemId:agentId,toolSlug,connectionId:assignment.connectionId,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
          else if(input.connectionId!==undefined && input.connectionId!==before.connectionId)recordAudit(store.db,{id:crypto.randomUUID(),action:'AGENT_TOOL_CONNECTION_CHANGED',itemId:agentId,toolSlug,connectionId:assignment.connectionId,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
          return send(200,assignment);
        }
        if(req.method==='DELETE')return send(200,deleteAssignment(store.db,session.tenantId,agentId,toolSlug));
      }
      if(req.method==='GET' && url.pathname==='/api/tools') {
        authorize(session,['owner','operator']);
        return send(200,listToolDefinitions(store.db,{category:url.searchParams.get('category')||undefined}));
      }
      const toolConnections=url.pathname.match(/^\/api\/tools\/([\w-]+)\/connections$/);
      if(req.method==='GET' && toolConnections) {
        authorize(session,['owner','operator']);
        const tool=getToolDefinition(store.db,toolConnections[1]);
        if(!tool)fail(404,'أداة غير معروفة');
        // Phase 6F fix — a generic, capability-only tool (integrationSlug:null; get_invoices/
        // get_orders/get_customers and any future one) used to ALWAYS get an empty list here,
        // even when a real compatible connection existed — this route pre-dates Phase 6D's
        // generic capability resolution and was never updated to match, so the Agent config
        // drawer's own connection dropdown silently showed zero options for these tools. Reuses
        // the exact same compatibility check `resolveGenericCapabilityTool`/`upsertAssignment`
        // already enforce — never a second, divergent definition of "compatible".
        if(!tool.integrationSlug) {
         const compatible=new Set(listCompatibleConnections(store.db,session.tenantId,tool.capability).map(c=>c.id));
         const anyHealthy=listConnections(store.db,{},session.tenantId).filter(c=>['CONNECTED','DEGRADED'].includes(c.status));
         return send(200,anyHealthy.map(c=>({...c,capabilityGranted:compatible.has(c.id)})));
        }
        // Phase 4B.1 (Part 10) — `capabilityGranted` tells a UI, per candidate connection,
        // whether its actual OAuth scopes cover what this tool needs — never just "supported
        // by the provider in general" (Part 6). `scopes` itself is already non-secret (see
        // connections.js hydrate); no credential is ever included here.
        const connections=listConnections(store.db,{integrationDefinitionId:tool.integrationSlug},session.tenantId);
        return send(200,connections.map(c=>({...c,capabilityGranted:connectionGrantsCapability(tool.integrationSlug,tool.capability,c.scopes)})));
      }
      const agentReadiness=url.pathname.match(/^\/api\/agents\/([\w-]+)\/readiness$/);
      if(req.method==='GET' && agentReadiness) {
        authorize(session,['owner','operator']);
        if(!getAgent(store.db,agentReadiness[1]))fail(404,'وكيل غير موجود');
        return send(200,evaluateAgentReadiness(store.db,env,{tenantId:session.tenantId,agentId:agentReadiness[1]}));
      }
      // Multi-Tenant Phase 4C-2 — Control Center. ONE real, tenant-scoped aggregation call
      // (src/runtime/control-center.js) so the whole dashboard never needs N+1 fetches from
      // the frontend (Phase 4B's own performance principle). Same owner/operator bar as every
      // other agent-config/readiness read this dashboard surfaces — a reviewer has no
      // legitimate reason to see connection/AI-provider configuration.
      if(req.method==='GET' && url.pathname==='/api/control-center/summary') {
        authorize(session,['owner','operator']);
        return send(200,buildControlCenterSummary(store.db,env,session.tenantId,session.user.role));
      }
      // Multi-Tenant Phase 4C-4 — Guided Workspace Onboarding. Configures the CURRENT,
      // already-existing tenant only (session.tenantId) — never creates one. Every step's
      // `state` is re-derived live on every GET (src/onboarding.js) — the frontend cannot mark
      // a step done by asserting it; same owner/operator read bar as Control Center, but
      // mutating (`PATCH`/preset) is owner-only, matching every other config-mutating route.
      if(req.method==='GET' && url.pathname==='/api/onboarding') {
        authorize(session,['owner','operator']);
        return send(200,getOnboardingState(store.db,env,session.tenantId));
      }
      if(req.method==='PATCH' && url.pathname==='/api/onboarding') {
        authorize(session,['owner']);
        const input=await body(req);
        const before=getOnboardingState(store.db,env,session.tenantId);
        const updated=updateOnboardingState(store.db,env,session.tenantId,input);
        const now=new Date().toISOString();
        if(before.status==='NOT_STARTED')recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_ONBOARDING_STARTED',itemId:session.tenantId,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
        if(input.complete===true)recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_ONBOARDING_COMPLETED',itemId:session.tenantId,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
        else if(input.reopen===true)recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_ONBOARDING_REOPENED',itemId:session.tenantId,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
        else if(input.skipStep!==undefined)recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_ONBOARDING_STEP_SKIPPED',itemId:input.skipStep,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
        // A step transition where the step being LEFT is genuinely READY counts as that step's
        // completion (Part 60) — never logged on every render, only on an explicit advance.
        else if(input.currentStep!==undefined) {
         const leaving=before.steps.find(s=>s.id===before.currentStep);
         if(leaving && leaving.state==='READY')recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_ONBOARDING_STEP_COMPLETED',itemId:leaving.id,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
        }
        return send(200,updated);
      }
      if(req.method==='GET' && url.pathname==='/api/onboarding/safety') {
        authorize(session,['owner','operator']);
        return send(200,safetySnapshot(store.db,env,session.tenantId));
      }
      if(req.method==='POST' && url.pathname==='/api/onboarding/preset') {
        authorize(session,['owner']);
        const input=await body(req);
        if(typeof input.aiConnectionId!=='string'||!input.aiConnectionId)fail(400,'aiConnectionId مطلوب');
        const result=applyRecommendedPreset(store.db,session.tenantId,{aiConnectionId:input.aiConnectionId,agentIds:input.agentIds});
        recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_ONBOARDING_PRESET_APPLIED',itemId:session.tenantId,detail:result.applied.join(','),actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,result);
      }
      if(req.method==='PATCH' && url.pathname==='/api/tenant/ai-default') {
        authorize(session,['owner']);
        const input=await body(req);
        if(input.connectionId!==undefined && input.connectionId!==null) {
          const connection=getConnectionOrNull(store.db,input.connectionId,session.tenantId);
          if(!connection)fail(400,'الاتصال غير موجود لهذه المنشأة');
          if(!['anthropic','openai'].includes(connection.integrationDefinitionId))fail(400,'الاتصال المحدد ليس اتصال مزوّد ذكاء اصطناعي');
        }
        const tenant=setWorkspaceAiDefault(store.db,session.tenantId,{connectionId:input.connectionId??null,model:input.model??null});
        recordAudit(store.db,{id:crypto.randomUUID(),action:'WORKSPACE_AI_DEFAULT_CHANGED',itemId:session.tenantId,connectionId:tenant.defaultAiConnectionId,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,tenant);
      }
      if(req.method==='PATCH' && url.pathname==='/api/tenant/safety-ceiling') {
        authorize(session,['owner']);
        const input=await body(req);
        if(input.level!==null && !autonomyLevels.includes(input.level))fail(400,'مستوى غير صالح');
        const tenant=setMaxAgentLevel(store.db,session.tenantId,input.level??null);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'TENANT_SAFETY_CEILING_CHANGED',itemId:session.tenantId,detail:input.level||'NONE',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,tenant);
      }
      if(url.pathname==='/api/approvals') {
        if(req.method==='GET')return send(200,listApprovals(store.db,{status:url.searchParams.get('status')||undefined},session.tenantId));
      }
      const approvalDecide=url.pathname.match(/^\/api\/approvals\/([\w-]+)\/decide$/);
      if(req.method==='POST' && approvalDecide) {
        authorize(session,['owner']);
        const input=await body(req);
        const decided=decideApproval(store.db,approvalDecide[1],input.decision,session.user,session.tenantId);
        return send(200,await applyApprovalDecision(decided,{user:session.user,tenantId:session.tenantId}));
      }
      if(req.method==='GET' && url.pathname==='/api/escalations')return send(200,listEscalations(store.db,{status:url.searchParams.get('status')||undefined},session.tenantId));
      const escalationResolve=url.pathname.match(/^\/api\/escalations\/([\w-]+)\/resolve$/);
      if(req.method==='POST' && escalationResolve) {
        authorize(session,['owner']);
        return send(200,resolveEscalation(store.db,escalationResolve[1],session.user,session.tenantId));
      }
      // ---------------------------------------------------------------------------------
      // Frost Command Center (Phase 7A) — chat, live operations, data & context, suggestions.
      // Chat execution goes through the exact same agentRuntime.run('frost_commander',...)
      // every other agent uses (see src/runtime/command-chat.js's module doc) — no second
      // orchestrator/tool registry/approval engine here, only the thin session bookkeeping
      // (conversations/messages) and read-only aggregation routes below.
      // ---------------------------------------------------------------------------------
      if(url.pathname==='/api/command/conversations') {
        if(req.method==='GET')return send(200,listConversations(store.db,session.tenantId));
        if(req.method==='POST') {
          const input=await body(req);
          return send(201,createConversation(store.db,session.user,session.tenantId,typeof input.title==='string'?input.title.slice(0,200):null,typeof input.projectId==='string'?input.projectId:null));
        }
      }
      const conversationRename=url.pathname.match(/^\/api\/command\/conversations\/([\w-]+)$/);
      if(req.method==='PATCH' && conversationRename) {
        const input=await body(req);
        // `projectId` (a project id, or null to take the chat out of its project) moves the chat;
        // `title` renames it. Sending only a blank/missing title keeps the old 400 behaviour.
        if(input.projectId!==undefined) {
          authorize(session,['owner','operator']);
          const moved=moveConversation(store.db,conversationRename[1],typeof input.projectId==='string'?input.projectId:null,session.tenantId);
          if(input.title===undefined)return send(200,moved);
        }
        return send(200,renameConversation(store.db,conversationRename[1],input.title,session.tenantId));
      }
      if(url.pathname==='/api/command/projects') {
        if(req.method==='GET')return send(200,listProjects(store.db,session.tenantId));
        if(req.method==='POST') {authorize(session,['owner','operator']);const input=await body(req);return send(201,createProject(store.db,session.user,session.tenantId,input.name));}
      }
      const projectItem=url.pathname.match(/^\/api\/command\/projects\/([\w-]+)$/);
      if(req.method==='PATCH' && projectItem) {authorize(session,['owner','operator']);const input=await body(req);return send(200,renameProject(store.db,projectItem[1],input.name,session.tenantId));}
      const projectArchive=url.pathname.match(/^\/api\/command\/projects\/([\w-]+)\/archive$/);
      if(req.method==='POST' && projectArchive) {authorize(session,['owner','operator']);return send(200,archiveProject(store.db,projectArchive[1],session.tenantId));}
      const conversationArchive=url.pathname.match(/^\/api\/command\/conversations\/([\w-]+)\/archive$/);
      if(req.method==='POST' && conversationArchive)return send(200,archiveConversation(store.db,conversationArchive[1],session.tenantId));
      const conversationMessages=url.pathname.match(/^\/api\/command\/conversations\/([\w-]+)\/messages$/);
      if(conversationMessages) {
        if(req.method==='GET')return send(200,listMessages(store.db,conversationMessages[1],session.tenantId));
        if(req.method==='POST') {
          authorize(session,['owner','operator']);
          checkLlmRateLimit(session.user.id);
          const input=await body(req);
          const attachmentContext=input.attachmentId?readAttachmentTextForChat(store.db,env,input.attachmentId,session.tenantId):null;
          const {assistantMessage,run}=await sendCommandMessage({store,agentRuntime,env,tenantId:session.tenantId,user:session.user,conversationId:conversationMessages[1],text:input.text,attachmentContext});
          return send(201,{assistantMessage,runStatus:run.status});
        }
      }
      if(req.method==='GET' && url.pathname==='/api/command/health')return send(200,computeCompanyHealth(store,session.tenantId));
      if(req.method==='GET' && url.pathname==='/api/command/quick-commands')return send(200,{keys:deriveQuickCommandKeys(store,session.tenantId)});
      // Data Inbox (spec item 14) — a real, merged, tenant-scoped feed across every existing
      // data source already found in this codebase (CRM, Content, Tasks/Escalations,
      // Integrations, Webhooks) — no new table, no fabricated rows, never the raw webhook
      // payload (only its type/source/status).
      if(req.method==='GET' && url.pathname==='/api/command/inbox') {
        const items=[];
        for(const lead of listLeads(store.db,session.tenantId).slice(0,20))items.push({kind:'crm_lead',id:lead.id,title:lead.company||lead.name,at:lead.createdAt});
        for(const followup of listFollowups(store.db,session.tenantId).slice(0,20))items.push({kind:'crm_followup',id:followup.id,title:followup.sequence||'متابعة',at:followup.createdAt||followup.dueAt});
        for(const item of listContent(store.db,session.tenantId).slice(0,20))items.push({kind:'content',id:item.id,title:item.title,at:item.createdAt});
        for(const escalation of listEscalations(store.db,{},session.tenantId).slice(0,20))items.push({kind:'escalation',id:escalation.id,title:escalation.reason,at:escalation.created_at});
        for(const connection of listConnections(store.db,{},session.tenantId).slice(0,20))items.push({kind:'connection',id:connection.id,title:connection.name,at:connection.createdAt});
        for(const source of ['salla','meta']) {
          try{for(const event of listWebhookEvents(store.db,{source,limit:10},session.tenantId))items.push({kind:'webhook',id:event.id,title:`${source} · ${event.type}`,at:event.received_at});}
          catch{/* source table may not exist in a bare fixture */}
        }
        const sorted=items.filter(i=>i.at).sort((a,b)=>(b.at||'').localeCompare(a.at||'')).slice(0,60);
        return send(200,{items:sorted});
      }
      if(req.method==='GET' && url.pathname==='/api/command/operations') {
        const runs=listRuns(store.db,{limit:40},session.tenantId).map(r=>({kind:'agent_run',id:r.id,agentId:r.agent_id,triggerType:r.trigger_type,status:r.status,at:r.started_at,finishedAt:r.finished_at,latencyMs:r.latency_ms,actorName:r.actor_name}));
        // Phase 7C (spec Part 68) — Workflow runs surfaced in the SAME Live Operations feed,
        // never a separate timeline: Workflow/Run/Status/Duration, with the real workflow name
        // resolved from workflow_definitions (no second name-lookup table).
        const workflowRuns=listWorkflowRuns(store.db,session.tenantId,{limit:20}).map(r=>{
          const workflow=store.db.prepare('SELECT name_ar FROM workflow_definitions WHERE id=?').get(r.workflowId);
          return {kind:'workflow_run',id:r.id,workflowId:r.workflowId,workflowName:workflow?.name_ar||r.workflowId,triggerType:r.triggerType,status:r.status,at:r.startedAt,finishedAt:r.finishedAt,
           cancellable:['PENDING','RUNNING','WAITING','WAITING_APPROVAL','CANCEL_REQUESTED'].includes(r.status)};
        });
        const auditEntries=listAuditLog(store.db,{tenantId:session.tenantId,limit:40}).map(a=>({kind:'audit',id:a.id,action:a.action,at:a.at,actorName:a.actorName||null}));
        const items=[...runs,...workflowRuns,...auditEntries].sort((a,b)=>(b.at||'').localeCompare(a.at||'')).slice(0,60);
        return send(200,{items});
      }
      if(url.pathname==='/api/command/context') {
        if(req.method==='GET')return send(200,listContextItems(store.db,session.tenantId,{type:url.searchParams.get('type')||undefined,status:url.searchParams.get('status')||'ACTIVE'}).map(withFreshness));
        if(req.method==='POST') {
          authorize(session,['owner','operator']);
          const input=await body(req);
          return send(201,createContextItem(store.db,input,session.user,session.tenantId));
        }
      }
      const contextUpdate=url.pathname.match(/^\/api\/command\/context\/([\w-]+)$/);
      if(req.method==='PATCH' && contextUpdate) {
        authorize(session,['owner','operator']);
        const input=await body(req);
        return send(200,updateContextItem(store.db,contextUpdate[1],input,session.user,session.tenantId));
      }
      const contextArchive=url.pathname.match(/^\/api\/command\/context\/([\w-]+)\/archive$/);
      if(req.method==='POST' && contextArchive) {
        authorize(session,['owner','operator']);
        return send(200,archiveContextItem(store.db,contextArchive[1],session.user,session.tenantId));
      }
      if(req.method==='GET' && url.pathname==='/api/command/suggestions')return send(200,syncSuggestions(store.db,session.tenantId).filter(s=>(url.searchParams.get('status')||'OPEN')===s.status));
      const suggestionAccept=url.pathname.match(/^\/api\/command\/suggestions\/([\w-]+)\/accept$/);
      if(req.method==='POST' && suggestionAccept) {authorize(session,['owner','operator']);return send(200,acceptSuggestion(store.db,suggestionAccept[1],session.user,session.tenantId));}
      const suggestionDismiss=url.pathname.match(/^\/api\/command\/suggestions\/([\w-]+)\/dismiss$/);
      if(req.method==='POST' && suggestionDismiss) {authorize(session,['owner','operator']);return send(200,dismissSuggestion(store.db,suggestionDismiss[1],session.user,session.tenantId));}
      const suggestionTask=url.pathname.match(/^\/api\/command\/suggestions\/([\w-]+)\/create-task$/);
      if(req.method==='POST' && suggestionTask) {authorize(session,['owner','operator']);return send(201,createTaskFromSuggestion(store.db,suggestionTask[1],session.user,session.tenantId));}
      const suggestionAutomate=url.pathname.match(/^\/api\/command\/suggestions\/([\w-]+)\/automate$/);
      if(req.method==='POST' && suggestionAutomate) {
        authorize(session,['owner','operator']);
        const suggestion=listSuggestions(store.db,session.tenantId).find(s=>s.id===suggestionAutomate[1]);
        if(!suggestion)fail(404,'الاقتراح غير موجود');
        const template=suggestionWorkflowTemplate(suggestion);
        return send(201,createWorkflowDraft(store.db,env,session.tenantId,template,session.user));
      }
      if(req.method==='GET' && url.pathname==='/api/command/system-map')return send(200,buildAgentConnectionMap(store.db,env,session.tenantId,{}));

      // -----------------------------------------------------------------------------------
      // Frost Command Center Phase 7B — Context conflict/freshness (spec Part 41-43), Command
      // Search (44), Runbooks/Favorites (12-14/45), Configuration History + Undo (20-23), and
      // safe Attachments (15-19). Same reuse discipline as Phase 7A: every read below is a real
      // aggregation over existing tables, every write goes through the same canonical service
      // functions, tenant-scoped throughout.
      // -----------------------------------------------------------------------------------
      if(req.method==='GET' && url.pathname==='/api/command/context/conflicts')return send(200,detectContextConflicts(store.db,session.tenantId));
      if(req.method==='GET' && url.pathname==='/api/command/search') {
        return send(200,searchCommands(store.db,session.tenantId,url.searchParams.get('q')||''));
      }
      if(url.pathname==='/api/command/runbooks') {
        if(req.method==='GET')return send(200,listRunbooks(store.db,session.tenantId));
        if(req.method==='POST') {
          authorize(session,['owner','operator']);
          const input=await body(req);
          return send(201,createRunbook(store.db,input,session.user,session.tenantId));
        }
      }
      const runbookArchive=url.pathname.match(/^\/api\/command\/runbooks\/([\w-]+)\/archive$/);
      if(req.method==='POST' && runbookArchive) {
        authorize(session,['owner','operator']);
        return send(200,archiveRunbook(store.db,runbookArchive[1],session.user,session.tenantId));
      }
      const runbookRun=url.pathname.match(/^\/api\/command\/runbooks\/([\w-]+)\/run$/);
      if(req.method==='POST' && runbookRun) {
        authorize(session,['owner','operator']);
        checkLlmRateLimit(session.user.id);
        const runbook=getRunbook(store.db,runbookRun[1],session.tenantId);
        const input=await body(req);
        const conversation=input.conversationId?{id:input.conversationId}:createConversation(store.db,session.user,session.tenantId,runbook.name);
        const {assistantMessage,run}=await sendCommandMessage({store,agentRuntime,env,tenantId:session.tenantId,user:session.user,conversationId:conversation.id,text:runbook.commandText});
        return send(201,{conversationId:conversation.id,assistantMessage,runStatus:run.status});
      }
      if(req.method==='GET' && url.pathname==='/api/command/configuration-history')return send(200,listConfigurationHistory(store.db,session.tenantId,{limit:50}));
      const configHistoryUndo=url.pathname.match(/^\/api\/command\/configuration-history\/([\w-]+)\/undo$/);
      if(req.method==='POST' && configHistoryUndo) {
        authorize(session,['owner']);
        return send(200,undoConfigurationChange(store.db,configHistoryUndo[1],session.user,session.tenantId));
      }
      if(url.pathname==='/api/command/attachments') {
        if(req.method==='GET')return send(200,listAttachments(store.db,session.tenantId,{conversationId:url.searchParams.get('conversationId')||undefined}));
        if(req.method==='POST') {
          authorize(session,['owner','operator']);
          // Base64-in-JSON inflates ~33% over the raw file — the shared body() reader's 64KB
          // cap (used by every other route) would refuse any real attachment, so this route
          // gets its own bounded raw reader instead, exactly like webhook signature
          // verification already does with rawBody() above.
          if(!req.headers['content-type']?.startsWith('application/json'))fail(415,'JSON مطلوب');
          const raw=await rawBody(req,Math.ceil(MAX_ATTACHMENT_BYTES*1.4)+8192);
          let input;try{input=JSON.parse(raw||'{}');}catch{fail(400,'JSON غير صالح');}
          return send(201,createAttachment(store.db,env,input,session.user,session.tenantId));
        }
      }
      // Phase MKT-2, Part K — the ONE gap in the existing attachment system: it stores real
      // files but never serves them back. Real Content-Type from the validated mime_type,
      // tenant-scoped exactly like getAttachment already is (a wrong-tenant id 404s the same
      // way, never leaking existence).
      const attachmentFileRoute=url.pathname.match(/^\/api\/command\/attachments\/([\w-]+)\/file$/);
      if(req.method==='GET' && attachmentFileRoute) {
        const attachment=getAttachment(store.db,attachmentFileRoute[1],session.tenantId);
        const row=store.db.prepare('SELECT disk_path FROM command_attachments WHERE id=? AND tenant_id=?').get(attachmentFileRoute[1],session.tenantId);
        if(!row||!existsSync(row.disk_path))fail(404,'الملف غير موجود على القرص');
        res.writeHead(200,{'Content-Type':attachment.mimeType,'Content-Disposition':`inline; filename="${encodeURIComponent(attachment.filename)}"`});
        return res.end(readFileSync(row.disk_path));
      }
      // Phase MKT-2, Part K — real marketing_assets CRUD (image/video/document/external URL/
      // creative reference metadata). Uploads reuse the EXISTING attachment store above rather
      // than a second one; this route only ever validates that a referenced upload's id is a
      // real attachment belonging to THIS tenant before accepting it.
      if(url.pathname==='/api/marketing/assets') {
        if(req.method==='GET')return send(200,listMarketingAssets(store.db,session.tenantId,{campaignId:url.searchParams.get('campaignId')||undefined,contentItemId:url.searchParams.get('contentItemId')||undefined}));
        if(req.method==='POST') {
         authorize(session,['owner','operator']);
         const input=await body(req);
         if(input.source==='upload')getAttachment(store.db,input.fileRef,session.tenantId); // 404s if not this tenant's real attachment
         return send(201,createMarketingAsset(store.db,input,session.user,session.tenantId));
        }
      }
      const marketingAssetRoute=url.pathname.match(/^\/api\/marketing\/assets\/([\w-]+)$/);
      if(marketingAssetRoute) {
        if(req.method==='GET')return send(200,getMarketingAsset(store.db,marketingAssetRoute[1],session.tenantId));
        if(req.method==='PATCH') {
         authorize(session,['owner','operator']);
         const {approved}=await body(req);
         return send(200,setMarketingAssetApproval(store.db,marketingAssetRoute[1],!!approved,session.user,session.tenantId));
        }
        if(req.method==='DELETE') {
         authorize(session,['owner','operator']);
         return send(200,deleteMarketingAsset(store.db,marketingAssetRoute[1],session.user,session.tenantId));
        }
      }
      // -----------------------------------------------------------------------------------
      // Frost Command Center Phase 7C — Native Workflow Engine HTTP surface. Every write
      // route below delegates straight to workflow-engine.js's own real validation/tenant
      // scoping; this file adds only session/role gating, matching every other route here.
      // -----------------------------------------------------------------------------------
      if(url.pathname==='/api/workflows/meta' && req.method==='GET')
        return send(200,{stepTypes:WORKFLOW_STEP_TYPES,triggerTypes:WORKFLOW_TRIGGER_TYPES,conditionOperators:CONDITION_OPERATORS,eventTypes:EVENT_TYPES});
      if(url.pathname==='/api/command/workflows-summary' && req.method==='GET')
        return send(200,summarizeWorkflowsForCommandCenter(store.db,session.tenantId));
      if(url.pathname==='/api/command/ai-usage' && req.method==='GET')
        return send(200,getAiUsageSummary(store.db,session.tenantId,{period:url.searchParams.get('period')||'today'}));
      if(url.pathname==='/api/workflows') {
        if(req.method==='GET')return send(200,listWorkflows(store.db,session.tenantId,{status:url.searchParams.get('status')||undefined}));
        if(req.method==='POST') {
          authorize(session,['owner','operator']);
          return send(201,createWorkflowDraft(store.db,env,session.tenantId,await body(req),session.user));
        }
      }
      const workflowItem=url.pathname.match(/^\/api\/workflows\/([\w-]+)$/);
      if(workflowItem) {
        if(req.method==='GET')return send(200,getWorkflowWithVersion(store.db,workflowItem[1],session.tenantId));
        if(req.method==='PATCH') {
          authorize(session,['owner','operator']);
          return send(200,updateWorkflowDraft(store.db,env,workflowItem[1],await body(req),session.user,session.tenantId));
        }
      }
      const workflowReadiness=url.pathname.match(/^\/api\/workflows\/([\w-]+)\/readiness$/);
      if(req.method==='GET' && workflowReadiness) {
        const workflow=getWorkflowWithVersion(store.db,workflowReadiness[1],session.tenantId);
        if(!workflow.version)return send(200,{ready:false,blockers:[{reason:'لا يوجد إصدار'}]});
        return send(200,computeWorkflowReadiness(store.db,env,session.tenantId,workflow.version));
      }
      const workflowActivate=url.pathname.match(/^\/api\/workflows\/([\w-]+)\/activate$/);
      if(req.method==='POST' && workflowActivate) {authorize(session,['owner']);return send(200,activateWorkflow(store.db,env,workflowActivate[1],session.user,session.tenantId));}
      const workflowPause=url.pathname.match(/^\/api\/workflows\/([\w-]+)\/pause$/);
      if(req.method==='POST' && workflowPause) {authorize(session,['owner']);return send(200,pauseWorkflow(store.db,workflowPause[1],session.user,session.tenantId));}
      const workflowResume=url.pathname.match(/^\/api\/workflows\/([\w-]+)\/resume$/);
      if(req.method==='POST' && workflowResume) {authorize(session,['owner']);return send(200,resumeWorkflow(store.db,workflowResume[1],session.user,session.tenantId));}
      const workflowArchive=url.pathname.match(/^\/api\/workflows\/([\w-]+)\/archive$/);
      if(req.method==='POST' && workflowArchive) {authorize(session,['owner']);return send(200,archiveWorkflow(store.db,workflowArchive[1],session.user,session.tenantId));}
      const workflowRun=url.pathname.match(/^\/api\/workflows\/([\w-]+)\/run$/);
      if(req.method==='POST' && workflowRun) {
        authorize(session,['owner','operator']);
        return send(201,await startWorkflowRun(workflowDeps,workflowRun[1],{triggerType:'MANUAL',tenantId:session.tenantId}));
      }
      const workflowRunsList=url.pathname.match(/^\/api\/workflows\/([\w-]+)\/runs$/);
      if(req.method==='GET' && workflowRunsList)return send(200,listWorkflowRuns(store.db,session.tenantId,{workflowId:workflowRunsList[1]}));
      const workflowRunDetail=url.pathname.match(/^\/api\/workflow-runs\/([\w-]+)$/);
      if(req.method==='GET' && workflowRunDetail)return send(200,getRunWithSteps(store.db,workflowRunDetail[1],session.tenantId));
      const workflowRunCancel=url.pathname.match(/^\/api\/workflow-runs\/([\w-]+)\/cancel$/);
      if(req.method==='POST' && workflowRunCancel) {
        authorize(session,['owner','operator']);
        return send(200,requestCancelWorkflowRun(store.db,workflowRunCancel[1],session.user,session.tenantId));
      }

      const attachmentPin=url.pathname.match(/^\/api\/command\/attachments\/([\w-]+)\/pin-to-brain$/);
      if(req.method==='POST' && attachmentPin) {
        authorize(session,['owner','operator']);
        const input=await body(req);
        const attachment=getAttachment(store.db,attachmentPin[1],session.tenantId);
        const contextItem=createContextItem(store.db,{type:input.type||'client_note',title:input.title||attachment.filename,
         description:input.description||`مرفق محفوظ من المحادثة: ${attachment.filename}`,source:'attachment',category:'attachment'},session.user,session.tenantId);
        return send(200,pinAttachmentToBrain(store.db,attachmentPin[1],contextItem.id,session.tenantId));
      }

      // -----------------------------------------------------------------------------------
      // Marketing & Social Operating Module (Phase MKT-1). Reuses agentRuntime/CRM/content/
      // reporting/approvals/runbooks entirely — the only new state here is campaigns and the
      // richer campaign content item (see src/marketing.js's own doc comment).
      // -----------------------------------------------------------------------------------
      if(req.method==='GET' && url.pathname==='/api/marketing/overview') {
        const agentRows=listRegistryAgents(store.db),agentRunsRows=listRuns(store.db,{},session.tenantId),
         escalationRows=listEscalations(store.db,{},session.tenantId),approvalRows=listApprovals(store.db,{},session.tenantId);
        return send(200,buildMarketingOverview(store,env,{agents:agentRows,agentRuns:agentRunsRows,escalations:escalationRows,approvals:approvalRows},session.tenantId));
      }
      if(url.pathname==='/api/marketing/campaigns') {
        if(req.method==='GET')return send(200,listCampaigns(store.db,session.tenantId,{status:url.searchParams.get('status')||undefined}));
        if(req.method==='POST') {authorize(session,['owner','operator']);return send(201,createCampaign(store.db,await body(req),session.user,session.tenantId));}
      }
      const campaignItem=url.pathname.match(/^\/api\/marketing\/campaigns\/([\w-]+)$/);
      if(campaignItem) {
        if(req.method==='GET')return send(200,getCampaign(store.db,campaignItem[1],session.tenantId));
        if(req.method==='PATCH') {authorize(session,['owner','operator']);return send(200,updateCampaign(store.db,campaignItem[1],await body(req),session.user,session.tenantId));}
      }
      const campaignArchive=url.pathname.match(/^\/api\/marketing\/campaigns\/([\w-]+)\/archive$/);
      if(req.method==='POST' && campaignArchive) {authorize(session,['owner','operator']);return send(200,archiveCampaign(store.db,campaignArchive[1],session.user,session.tenantId));}
      // WhatsApp campaign blast — the human-operated path to the same bounded, capped send
      // logic the whatsapp_campaign_send agent tool uses (runtime/whatsapp.js's
      // sendWhatsAppCampaign), so an operator and Frost can never diverge on eligibility rules.
      // getCampaign() below both validates tenant ownership of campaignId and 404s a foreign one.
      const campaignWhatsappBlast=url.pathname.match(/^\/api\/marketing\/campaigns\/([\w-]+)\/whatsapp-blast$/);
      if(req.method==='POST' && campaignWhatsappBlast) {
        authorize(session,['owner','operator']);
        const campaignId=campaignWhatsappBlast[1];
        getCampaign(store.db,campaignId,session.tenantId);
        const input=await body(req);
        const result=await sendWhatsAppCampaign({store,env,fetcher},{...input,campaignId},session.user,session.tenantId);
        return send(200,result);
      }
      // Real multi-agent delegation (spec Part 7): a genuine agentRuntime.run('intelligence'/
      // 'strategy', …) call — never a canned template. If AI is not configured or the run
      // fails, the campaign's strategy/intelligence simply stays null (shown honestly), not a
      // fabricated plan.
      const campaignIntelligence=url.pathname.match(/^\/api\/marketing\/campaigns\/([\w-]+)\/generate-intelligence$/);
      if(req.method==='POST' && campaignIntelligence) {
        authorize(session,['owner','operator']);
        const campaign=getCampaign(store.db,campaignIntelligence[1],session.tenantId);
        const run=await agentRuntime.run('intelligence',{triggerType:'MANUAL',input:{task:'marketing_intelligence',campaignName:campaign.name,product:campaign.product,market:campaign.market,audience:campaign.audience,current_datetime:new Date().toISOString()},user:session.user,tenantId:session.tenantId});
        if(run.output?.payload)saveCampaignIntelligence(store.db,campaign.id,run.output.payload,session.tenantId);
        return send(200,{run:{id:run.id,status:run.status},campaign:getCampaign(store.db,campaign.id,session.tenantId)});
      }
      const campaignStrategy=url.pathname.match(/^\/api\/marketing\/campaigns\/([\w-]+)\/generate-strategy$/);
      if(req.method==='POST' && campaignStrategy) {
        authorize(session,['owner','operator']);
        const campaign=getCampaign(store.db,campaignStrategy[1],session.tenantId);
        const run=await agentRuntime.run('strategy',{triggerType:'MANUAL',input:{task:'marketing_campaign_strategy',campaignName:campaign.name,goal:campaign.goal,product:campaign.product,audience:campaign.audience,market:campaign.market,offer:campaign.offer,channels:campaign.channels,tone:campaign.tone,cta:campaign.cta,marketIntelligence:campaign.intelligence,current_datetime:new Date().toISOString()},user:session.user,tenantId:session.tenantId});
        if(run.output?.payload)saveCampaignStrategy(store.db,campaign.id,run.output.payload,session.tenantId);
        return send(200,{run:{id:run.id,status:run.status},campaign:getCampaign(store.db,campaign.id,session.tenantId)});
      }
      // Phase MKT-2, Part B — OPTIONAL automated campaign orchestration, built entirely on the
      // existing native Workflow Engine (see src/marketing.js's own doc comment). MANUAL mode
      // (the two routes just above) is completely unaffected and remains available regardless
      // of whether a campaign also has an orchestration workflow.
      const campaignOrchestrationCreate=url.pathname.match(/^\/api\/marketing\/campaigns\/([\w-]+)\/orchestration$/);
      if(req.method==='POST' && campaignOrchestrationCreate) {
        authorize(session,['owner','operator']);
        const campaign=getCampaign(store.db,campaignOrchestrationCreate[1],session.tenantId);
        return send(201,createCampaignOrchestrationWorkflow(store.db,env,campaign,session.user,session.tenantId));
      }
      if(req.method==='GET' && campaignOrchestrationCreate) {
        const campaign=getCampaign(store.db,campaignOrchestrationCreate[1],session.tenantId);
        if(!campaign.orchestrationWorkflowId)return send(200,{campaign,workflow:null,runs:[]});
        const workflow=getWorkflowWithVersion(store.db,campaign.orchestrationWorkflowId,session.tenantId);
        // Real step-level detail per run (agent output, WAITING_APPROVAL state, etc.) — a
        // campaign realistically has very few orchestration runs, so fetching each run's full
        // step list here (rather than only a run summary) is cheap and lets the UI show real
        // progress without a second round-trip per run.
        const runs=listWorkflowRuns(store.db,session.tenantId,{workflowId:campaign.orchestrationWorkflowId}).map(run=>getRunWithSteps(store.db,run.id,session.tenantId));
        return send(200,{campaign,workflow,runs});
      }
      const campaignOrchestrationRun=url.pathname.match(/^\/api\/marketing\/campaigns\/([\w-]+)\/orchestration\/run$/);
      if(req.method==='POST' && campaignOrchestrationRun) {
        authorize(session,['owner','operator']);
        const campaign=getCampaign(store.db,campaignOrchestrationRun[1],session.tenantId);
        if(!campaign.orchestrationWorkflowId)fail(400,'أنشئ مسار التنسيق التلقائي أولاً لهذه الحملة');
        const run=await startWorkflowRun(workflowDeps,campaign.orchestrationWorkflowId,{triggerType:'MANUAL',triggerContext:campaignOrchestrationTriggerContext(campaign),tenantId:session.tenantId});
        return send(201,run);
      }
      // Phase MKT-2, Part F — real, normalized cross-provider analytics. Sync is a manual,
      // explicit action (owner/operator only) rather than an automatic background poller —
      // this app has no job scheduler for external-API polling beyond the existing
      // scheduler.js (reserved for publish jobs); a manual sync keeps the behavior honest and
      // observable rather than adding a second background timer.
      if(req.method==='POST' && url.pathname==='/api/marketing/analytics/sync') {
        authorize(session,['owner','operator']);
        return send(200,await syncAllMarketingAnalytics({store,env,fetcher},session.tenantId));
      }
      if(req.method==='GET' && url.pathname==='/api/marketing/analytics/summary') {
        return send(200,getMarketingAnalyticsSummary(store.db,session.tenantId));
      }
      // Phase MKT-2, Part G — the EXISTING performance agent (#11, agents/performance.md),
      // run for real over whatever real analytics currently exist (getMarketingAnalyticsSummary
      // — see marketing-analytics.js's module note: today that's account/provider-level, not
      // aggregated/rolled up by campaign). `campaignId` is an optional human-facing tag only.
      // The stored review keeps
      // the exact evidence shown to the agent and its full structured recommendation —
      // `experiments_next_week`/`stop_doing`/`double_down` — and is never auto-applied to any
      // content (Part G: "must NOT auto-modify or publish content").
      if(req.method==='POST' && url.pathname==='/api/marketing/performance/review') {
        authorize(session,['owner','operator']);
        const input=await body(req);
        const evidence=getMarketingAnalyticsSummary(store.db,session.tenantId);
        if(!evidence.hasAnyData)fail(409,'لا توجد بيانات تحليلات حقيقية بعد — شغّل مزامنة التحليلات أولاً');
        const run=await agentRuntime.run('performance',{triggerType:'MANUAL',input:{task:'marketing_performance_review',metrics:evidence,current_datetime:new Date().toISOString()},user:session.user,tenantId:session.tenantId});
        if(!run.output?.payload)return send(200,{run:{id:run.id,status:run.status},review:null});
        const review=recordPerformanceReview(store.db,{campaignId:input?.campaignId||null,runId:run.id,evidence,result:run.output.payload},session.user,session.tenantId);
        return send(201,{run:{id:run.id,status:run.status},review});
      }
      if(req.method==='GET' && url.pathname==='/api/marketing/performance/reviews') {
        return send(200,listPerformanceReviews(store.db,session.tenantId,{campaignId:url.searchParams.get('campaignId')||undefined}));
      }
      const performanceReviewRoute=url.pathname.match(/^\/api\/marketing\/performance\/reviews\/([\w-]+)$/);
      if(req.method==='GET' && performanceReviewRoute) {
        return send(200,getPerformanceReview(store.db,performanceReviewRoute[1],session.tenantId));
      }
      const performanceReviewStatusRoute=url.pathname.match(/^\/api\/marketing\/performance\/reviews\/([\w-]+)\/status$/);
      if(req.method==='POST' && performanceReviewStatusRoute) {
        authorize(session,['owner','operator']);
        const {status}=await body(req);
        return send(200,setPerformanceReviewStatus(store.db,performanceReviewStatusRoute[1],status,session.user,session.tenantId));
      }
      // Phase MKT-2, Part H — the controlled improvement loop's only real action: a human
      // deciding to act on a stored recommendation creates a brand-new DRAFT content item
      // through the EXISTING, unchanged createCampaignContentItem path — never edits or
      // republishes anything already PUBLISHED (spec: "Never modify previously published
      // content history; create new version/item"). The new item still has to pass through the
      // full real compliance gate and human approval before it could ever be scheduled or
      // published — this route itself has no publishing capability at all. The link back to
      // the recommendation that inspired it is kept in the audit log, not a new column.
      const performanceReviewContentRoute=url.pathname.match(/^\/api\/marketing\/performance\/reviews\/([\w-]+)\/create-content$/);
      if(req.method==='POST' && performanceReviewContentRoute) {
        authorize(session,['owner','operator']);
        const review=getPerformanceReview(store.db,performanceReviewContentRoute[1],session.tenantId);
        const input=await body(req);
        const item=createCampaignContentItem(store.db,{...input,campaignId:input.campaignId||review.campaignId||null},session.user,session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'MARKETING_CONTENT_CREATED_FROM_RECOMMENDATION',itemId:item.id,detail:{reviewId:review.id,runId:review.runId},actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(201,item);
      }
      if(url.pathname==='/api/marketing/content') {
        if(req.method==='GET')return send(200,listCampaignContentItems(store.db,session.tenantId,{campaignId:url.searchParams.get('campaignId')||undefined,status:url.searchParams.get('status')||undefined}));
        if(req.method==='POST') {authorize(session,['owner','operator']);return send(201,createCampaignContentItem(store.db,await body(req),session.user,session.tenantId));}
      }
      const contentItemRoute=url.pathname.match(/^\/api\/marketing\/content\/([\w-]+)$/);
      if(contentItemRoute) {
        if(req.method==='GET')return send(200,getCampaignContentItem(store.db,contentItemRoute[1],session.tenantId));
        if(req.method==='PATCH') {authorize(session,['owner','operator']);return send(200,updateCampaignContentItem(store.db,contentItemRoute[1],await body(req),session.user,session.tenantId));}
      }
      // Phase MKT-2, Part C — the real compliance gate: a real agentRuntime.run('compliance', …)
      // call (never the legacy src/connectors.js checkCompliance() one-off, and never a second
      // compliance mechanism) whose decision is hash-pinned to this exact content by
      // saveComplianceResult. IN_REVIEW -> APPROVED is refused in updateCampaignContentItem
      // unless a matching, non-BLOCK result exists.
      const contentCompliance=url.pathname.match(/^\/api\/marketing\/content\/([\w-]+)\/run-compliance$/);
      if(req.method==='POST' && contentCompliance) {
        authorize(session,['owner','operator']);
        const item=getCampaignContentItem(store.db,contentCompliance[1],session.tenantId);
        const run=await agentRuntime.run('compliance',{triggerType:'MANUAL',input:{task:'marketing_content_compliance_review',channel:item.channel,format:item.format,hook:item.hook,body:item.body,cta:item.cta,hashtags:item.hashtags,current_datetime:new Date().toISOString()},user:session.user,tenantId:session.tenantId});
        const updated=saveComplianceResult(store.db,item.id,{runId:run.id,decision:run.output?.payload||null},session.tenantId);
        return send(200,{run:{id:run.id,status:run.status},content:updated});
      }
      // Phase MKT-2, Part D — real agentRuntime.run('creative', …); output populates the
      // existing creativeBrief field. Planning/instructions only — no Canva, no asset generation.
      const contentCreative=url.pathname.match(/^\/api\/marketing\/content\/([\w-]+)\/generate-creative$/);
      if(req.method==='POST' && contentCreative) {
        authorize(session,['owner','operator']);
        const item=getCampaignContentItem(store.db,contentCreative[1],session.tenantId);
        const run=await agentRuntime.run('creative',{triggerType:'MANUAL',input:{task:'marketing_creative_brief',channel:item.channel,format:item.format,hook:item.hook,body:item.body,cta:item.cta,current_datetime:new Date().toISOString()},user:session.user,tenantId:session.tenantId});
        const updated=saveCreativeBrief(store.db,item.id,{runId:run.id,payload:run.output?.payload||null},session.tenantId);
        return send(200,{run:{id:run.id,status:run.status},content:updated});
      }
      if(req.method==='GET' && url.pathname==='/api/marketing/calendar') {
        const items=listCampaignContentItems(store.db,session.tenantId).filter(i=>i.scheduledAt||i.publishedAt);
        return send(200,items);
      }
      // Unified Inbox (spec Part 23-25) — the CRM's own lead+message model already IS the
      // conversation/message model (findOrCreateLeadFromChannel/recordChannelMessage predate
      // this phase); this is a real read-only aggregation, never a second table.
      if(req.method==='GET' && url.pathname==='/api/marketing/inbox') {
        const leads=listLeads(store.db,session.tenantId);
        const conversations=leads.filter(l=>l.lastInboundAt||l.lastOutboundAt)
         .sort((a,b)=>(b.lastInboundAt||b.lastOutboundAt||'').localeCompare(a.lastInboundAt||a.lastOutboundAt||''))
         .slice(0,200)
         .map(l=>({leadId:l.id,name:l.name,channel:l.channelOrigin,stage:l.stage,temperature:l.temperature,
          lastInboundAt:l.lastInboundAt,lastOutboundAt:l.lastOutboundAt,replyHold:l.replyHold,humanHold:l.humanHold,assignedTo:l.assignedTo}));
        return send(200,conversations);
      }
      const inboxThread=url.pathname.match(/^\/api\/marketing\/inbox\/([\w-]+)\/messages$/);
      if(req.method==='GET' && inboxThread)return send(200,leadDetail(store.db,inboxThread[1],session.tenantId).messages);
      // Website Chat Widget config (tenant-side, authenticated) — the public chat endpoint
      // itself lives outside the session-gated router entirely (handlePublicWidgetRoute above).
      if(url.pathname==='/api/marketing/widget') {
        if(req.method==='GET')return send(200,getOrCreateWidget(store.db,session.tenantId));
        if(req.method==='PATCH') {authorize(session,['owner','operator']);return send(200,updateWidgetConfig(store.db,await body(req),session.user,session.tenantId));}
      }
      if(req.method==='POST' && url.pathname==='/api/marketing/widget/regenerate') {authorize(session,['owner']);return send(200,regenerateWidgetId(store.db,session.user,session.tenantId));}
      if(req.method==='GET' && url.pathname==='/api/marketing/meta') return send(200,{contentChannels:CONTENT_CHANNELS,contentFormats:CONTENT_FORMATS,campaignStatuses:CAMPAIGN_STATUSES,contentStatuses:CONTENT_STATUSES});

      if(req.method==='GET' && url.pathname==='/api/frost/daily-brief')return send(200,buildDailyBrief({store,db:store.db,listEscalations,listRuns,buildBriefFn:buildBrief,tenantId:session.tenantId}));
      if(req.method==='GET' && url.pathname==='/api/frost/status')return send(200,{gate:getGateStatus(store.db),schedulerRunning:scheduler.running(),routes:orchestratorRoutes});
      if(req.method==='POST' && url.pathname==='/api/frost/pause') {authorize(session,['owner']);requirePlatformOperator(store.db,env,session);const input=await body(req);return send(200,setPaused(store.db,true,session.user,typeof input.reason==='string'?input.reason.slice(0,1000):null));}
      if(req.method==='POST' && url.pathname==='/api/frost/resume') {authorize(session,['owner']);requirePlatformOperator(store.db,env,session);return send(200,setPaused(store.db,false,session.user));}
      if(req.method==='POST' && url.pathname==='/api/frost/run-now') {authorize(session,['owner']);requirePlatformOperator(store.db,env,session);return send(200,await scheduler.tick());}
      const autonomyRoute=url.pathname.match(/^\/api\/agents\/([\w-]+)\/autonomy$/);
      if(autonomyRoute) {
        if(req.method==='GET')return send(200,listAutonomyLog(store.db,autonomyRoute[1],session.tenantId));
        if(req.method==='POST') {authorize(session,['owner']);return send(201,setAutonomy(store,autonomyRoute[1],await body(req),session.user,env,session.tenantId));}
      }
      if(req.method==='GET' && url.pathname==='/api/connections') {requirePlatformOperator(store.db,env,session);return send(200,connectionStatus(env));}
      if(req.method==='GET' && url.pathname==='/api/integrations/dashboard') return send(200,buildIntegrationsDashboard(store,{env,aiRuns:listAiRuns(store.db,50,session.tenantId),complianceRuns:listComplianceChecksSince(store.db,'1970-01-01T00:00:00.000Z',session.tenantId),agentRuns:listRuns(store.db,{limit:2000},session.tenantId),tenantId:session.tenantId}));
      const integrationTest=url.pathname.match(/^\/api\/integrations\/([\w-]+)\/test$/);
      if(req.method==='POST' && integrationTest) {
        authorize(session,['owner']);
        const id=integrationTest[1];
        if(!isPlatformOperator(store.db,env,session)) {
          // A workspace tests ITS OWN connection with ITS OWN credential — never the server's platform keys or tokens.
          const own=getDefaultConnection(store.db,id,session.tenantId);
          if(!own)return send(200,{result:'NOT_CONFIGURED'});
          const health=await testConnectionHealth(own,{store,env,fetcher});
          return send(200,{result:health.status==='CONNECTED'?'OK':health.status,code:health.errors?.[0]||null});
        }
        if(id==='anthropic')return send(200,await testAnthropicConnection({env,fetcher}));
        if(id==='openai')return send(200,await testOpenAIConnection({env,fetcher}));
        if(id==='salla'){const resolved=await resolveSallaAccessToken({store,env,fetcher},session.tenantId);return send(200,await testSallaConnection({env,fetcher,accessToken:resolved?.token}));}
        if(id==='whatsapp')return send(200,await testWhatsAppConnection({store,env,fetcher},session.tenantId));
        if(id==='meta')return send(200,resolveMetaAccessToken({store,env},'page',session.tenantId)?{result:'OK'}:{result:'NOT_CONFIGURED',code:'META_NOT_CONFIGURED'});
        if(id==='microsoft365')return send(200,await testMicrosoftConnection({store,env,fetcher},session.tenantId));
        if(id==='x')return send(200,await testXConnection({store,env,fetcher},session.tenantId));
        if(id==='linkedin')return send(200,await testLinkedInConnection({store,env,fetcher},session.tenantId));
        return send(200,{result:'NOT_IMPLEMENTED'});
      }
      // Salla OAuth (owner only — connecting/disconnecting the store's own commerce data is
      // an ownership-level decision, same bar as any other integration credential).
      if(req.method==='GET' && url.pathname==='/api/integrations/salla/oauth/status') {
        authorize(session,['owner']);
        return send(200,sallaOAuthStatus(store.db,env,session.tenantId));
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/salla/oauth/start') {
        authorize(session,['owner']);
        res.writeHead(302,{Location:createAuthorizeUrl(env,session.user.id)});return res.end();
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/salla/oauth/callback') {
        authorize(session,['owner']);
        const code=url.searchParams.get('code'),state=url.searchParams.get('state');
        if(!code||!state)fail(400,'استجابة ربط سلة ناقصة (code/state)');
        consumeState(state,session.user.id);
        const tokens=await exchangeCodeForTokens({env,fetcher,code});
        saveCredentials(store.db,env,'salla',tokens,session.user,session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'SALLA_OAUTH_CONNECTED',itemId:'salla',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        res.writeHead(302,{Location:'/app#integrations'});return res.end();
      }
      if(req.method==='POST' && url.pathname==='/api/integrations/salla/disconnect') {
        authorize(session,['owner']);
        disconnectSalla(store.db,session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'SALLA_OAUTH_DISCONNECTED',itemId:'salla',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,{disconnected:true});
      }
      if(req.method==='GET' && url.pathname==='/api/webhooks/salla/events') {
        authorize(session,['owner']);
        return send(200,listWebhookEvents(store.db,{source:'salla',limit:Number(url.searchParams.get('limit'))||50},session.tenantId));
      }
      // Meta OAuth status is read-only (never returns tokens — see metaOAuthStatus) so it's
      // visible to operator too, same bar as the WhatsApp template/manual-send routes below;
      // only start/callback/disconnect stay owner-only.
      if(req.method==='GET' && url.pathname==='/api/integrations/meta/oauth/status') {
        authorize(session,['owner','operator']);
        return send(200,metaOAuthStatus(store.db,session.tenantId));
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/meta/oauth/start') {
        authorize(session,['owner']);
        res.writeHead(302,{Location:createMetaAuthorizeUrl(env,session.user.id)});return res.end();
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/meta/oauth/callback') {
        authorize(session,['owner']);
        const code=url.searchParams.get('code'),oauthState=url.searchParams.get('state');
        if(!code||!oauthState)fail(400,'استجابة ربط Meta ناقصة (code/state)');
        consumeMetaState(oauthState,session.user.id);
        const assets=await exchangeCodeAndResolveAssets({env,fetcher,code});
        saveMetaConnection(store.db,env,assets,session.user,session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'META_OAUTH_CONNECTED',itemId:'meta',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        res.writeHead(302,{Location:'/app#integrations'});return res.end();
      }
      if(req.method==='POST' && url.pathname==='/api/integrations/meta/disconnect') {
        authorize(session,['owner']);
        disconnectMeta(store.db,session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'META_OAUTH_DISCONNECTED',itemId:'meta',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,{disconnected:true});
      }
      if(req.method==='GET' && url.pathname==='/api/webhooks/meta/events') {
        authorize(session,['owner']);
        return send(200,listWebhookEvents(store.db,{source:'meta',limit:Number(url.searchParams.get('limit'))||50},session.tenantId));
      }
      // WhatsApp templates — real approval status pulled from Meta, never invented locally.
      if(req.method==='GET' && url.pathname==='/api/whatsapp/templates') {
        authorize(session,['owner','operator']);
        return send(200,listWhatsAppTemplates(store.db,{status:url.searchParams.get('status')||undefined},session.tenantId));
      }
      if(req.method==='POST' && url.pathname==='/api/whatsapp/templates/sync') {
        authorize(session,['owner']);
        const result=await syncWhatsAppTemplates({store,env,fetcher},session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'WHATSAPP_TEMPLATES_SYNCED',itemId:'whatsapp',count:result.synced,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,result);
      }
      // Manual send outside the agent runtime — an owner/operator replying by hand from the
      // Shared Inbox still goes through the exact same permission/opt-out/window checks as
      // the whatsapp_send agent tool (see runtime/tools.js), never a second, looser path.
      const manualWhatsAppSend=url.pathname.match(/^\/api\/crm\/leads\/([\w-]+)\/whatsapp-send$/);
      if(req.method==='POST' && manualWhatsAppSend) {
        authorize(session,['owner','operator']);
        const id=manualWhatsAppSend[1],input=await body(req);
        const lead=getLead(store.db,id,session.tenantId);
        if(lead.optOut)fail(409,'العميل أوقف التواصل (opt-out)');
        if(lead.humanHold)fail(409,'المحادثة موقوفة بانتظار مراجعة بشرية');
        if(!lead.phone)fail(409,'لا يوجد رقم هاتف لهذا العميل');
        if(!input.templateName && !(lead.lastInboundAt && Date.now()-Date.parse(lead.lastInboundAt)<=86400000))fail(409,'خارج نافذة خدمة العملاء (24 ساعة) — استخدم قالبًا معتمدًا');
        const result=await sendWhatsAppMessage({store,env,fetcher},{to:lead.phone,text:input.text,templateName:input.templateName,templateLanguage:input.templateLanguage},session.tenantId);
        if(result.status==='SENT')recordChannelMessage(store,{leadId:id,channel:'WhatsApp',direction:'OUTBOUND',text:input.text||`[template:${input.templateName}]`,externalMessageId:result.externalMessageId,messageType:input.templateName?'template':'text'},session.user,session.tenantId);
        return send(200,result);
      }
      // Microsoft 365 OAuth (owner only, same bar as Salla/Meta above).
      if(req.method==='GET' && url.pathname==='/api/integrations/microsoft/oauth/status') {
        authorize(session,['owner']);
        return send(200,microsoftOAuthStatus(store.db,session.tenantId));
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/microsoft/oauth/start') {
        authorize(session,['owner']);
        res.writeHead(302,{Location:createMicrosoftAuthorizeUrl(env,session.user.id)});return res.end();
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/microsoft/oauth/callback') {
        authorize(session,['owner']);
        const code=url.searchParams.get('code'),oauthState=url.searchParams.get('state');
        if(!code||!oauthState)fail(400,'استجابة ربط Microsoft ناقصة (code/state)');
        consumeMicrosoftState(oauthState,session.user.id);
        const tokens=await exchangeMicrosoftCodeForTokens({env,fetcher,code});
        const profile=await resolveConnectedProfile({env,fetcher,accessToken:tokens.accessToken});
        saveMicrosoftConnection(store.db,env,tokens,profile,session.user,session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'MICROSOFT_CONNECTED',itemId:'microsoft365',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        res.writeHead(302,{Location:'/app#integrations'});return res.end();
      }
      if(req.method==='POST' && url.pathname==='/api/integrations/microsoft/disconnect') {
        authorize(session,['owner']);
        // Delete the webhook subscription first (best-effort) so a disconnected mailbox
        // doesn't keep sending notifications this app can no longer act on.
        const meta=getCredentialsMeta(store.db,'microsoft365',session.tenantId);
        if(meta?.metadata?.mailSubscription?.id)await deleteMailSubscription({store,env,fetcher},meta.metadata.mailSubscription.id,session.tenantId);
        disconnectMicrosoft(store.db,session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'MICROSOFT_DISCONNECTED',itemId:'microsoft365',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,{disconnected:true});
      }
      // Creates the real Graph subscription that makes /api/webhooks/microsoft/mail
      // receive anything at all — a separate, explicit step from OAuth connect, since a
      // notificationUrl only resolves correctly once PUBLIC_ORIGIN/deployment is live.
      if(req.method==='POST' && url.pathname==='/api/integrations/microsoft/subscribe') {
        authorize(session,['owner']);
        if(!env.MICROSOFT_WEBHOOK_SECRET)fail(400,'أضف MICROSOFT_WEBHOOK_SECRET في إعدادات الخادم أولًا');
        if(!publicUrl)fail(400,'يتطلب اشتراك الويبهوك نطاقًا عامًا (PUBLIC_ORIGIN) — لا يقبل Graph عناوين محلية');
        const notificationUrl=new URL('/api/webhooks/microsoft/mail',publicUrl).href;
        const subscription=await createMailSubscription({store,env,fetcher},{notificationUrl,clientState:env.MICROSOFT_WEBHOOK_SECRET},session.tenantId);
        updateCredentialsMetadata(store.db,'microsoft365',{mailSubscription:{id:subscription.subscriptionId,expiresAt:subscription.expiresAt,resource:subscription.resource,createdAt:new Date().toISOString()}},session.tenantId,env);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'MICROSOFT_SUBSCRIPTION_CREATED',itemId:subscription.subscriptionId,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,subscription);
      }
      // X OAuth (owner only, same bar as Salla/Meta/Microsoft above). PKCE's code_verifier
      // never leaves the server (x-oauth.js keeps it in the same in-memory state map as the
      // CSRF nonce) — the browser round-trip only ever sees `code`/`state`.
      if(req.method==='GET' && url.pathname==='/api/integrations/x/oauth/status') {
        authorize(session,['owner']);
        return send(200,xOAuthStatus(store.db,session.tenantId));
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/x/oauth/start') {
        authorize(session,['owner']);
        res.writeHead(302,{Location:createXAuthorizeUrl(env,session.user.id)});return res.end();
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/x/oauth/callback') {
        authorize(session,['owner']);
        const code=url.searchParams.get('code'),oauthState=url.searchParams.get('state');
        if(!code||!oauthState)fail(400,'استجابة ربط X ناقصة (code/state)');
        const codeVerifier=consumeXState(oauthState,session.user.id);
        const tokens=await exchangeXCodeForTokens({env,fetcher,code,codeVerifier});
        const profile=await resolveXProfile({fetcher,accessToken:tokens.accessToken});
        saveXConnection(store.db,env,tokens,profile,session.user,session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'X_CONNECTED',itemId:'x',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        res.writeHead(302,{Location:'/app#integrations'});return res.end();
      }
      if(req.method==='POST' && url.pathname==='/api/integrations/x/disconnect') {
        authorize(session,['owner']);
        disconnectX(store.db,session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'X_DISCONNECTED',itemId:'x',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,{disconnected:true});
      }
      // LinkedIn OAuth (owner only, same bar as above). Organization resolution is a real,
      // separate API call (see resolveAdministeredOrganizations) — a connection can succeed
      // as identity-only if rw_organization_admin wasn't granted, in which case publishing
      // stays INTEGRATION_REQUIRED until an organization is actually resolved.
      if(req.method==='GET' && url.pathname==='/api/integrations/linkedin/oauth/status') {
        authorize(session,['owner']);
        return send(200,linkedInOAuthStatus(store.db,session.tenantId));
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/linkedin/oauth/start') {
        authorize(session,['owner']);
        res.writeHead(302,{Location:createLinkedInAuthorizeUrl(env,session.user.id)});return res.end();
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/linkedin/oauth/callback') {
        authorize(session,['owner']);
        const code=url.searchParams.get('code'),oauthState=url.searchParams.get('state');
        if(!code||!oauthState)fail(400,'استجابة ربط LinkedIn ناقصة (code/state)');
        consumeLinkedInState(oauthState,session.user.id);
        const tokens=await exchangeLinkedInCodeForTokens({env,fetcher,code});
        const profile=await resolveLinkedInProfile({fetcher,accessToken:tokens.accessToken});
        let organization=null;
        try{organization=(await resolveAdministeredOrganizations({fetcher,accessToken:tokens.accessToken}))[0]||null;}
        catch{organization=null;} // rw_organization_admin not granted yet — connection still succeeds as identity-only.
        saveLinkedInConnection(store.db,env,tokens,profile,organization,session.user,session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'LINKEDIN_CONNECTED',itemId:'linkedin',organizationId:organization?.id||null,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        if(organization)recordAudit(store.db,{id:crypto.randomUUID(),action:'LINKEDIN_ORGANIZATION_SELECTED',itemId:organization.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        res.writeHead(302,{Location:'/app#integrations'});return res.end();
      }
      if(req.method==='POST' && url.pathname==='/api/integrations/linkedin/disconnect') {
        authorize(session,['owner']);
        disconnectLinkedIn(store.db,session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'LINKEDIN_DISCONNECTED',itemId:'linkedin',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,{disconnected:true});
      }
      // ---------------------------------------------------------------------------------
      // Multi-Tenant Phase 4A — generic, multi-connection Integration Connection routes.
      // The six single-connection OAuth route blocks above are UNCHANGED and remain the
      // active path for meta/microsoft365/x/linkedin/whatsapp (and Salla's own default
      // connection). These new routes are ADDITIVE: they operate on `integration_connections`
      // (see src/integrations/connections.js), which the compatibility bridge in
      // credentials.js keeps mirrored from every legacy write. Only Salla is wired through
      // the generic OAuth start/callback below (the chosen multi-store proof-of-concept —
      // see docs/INTEGRATION_CONNECTION_ARCHITECTURE.md); other OAuth providers 501 on the
      // generic OAuth path and keep using their dedicated routes above. Credential
      // management (owner-only) never returns a secret — only safe metadata.
      // ---------------------------------------------------------------------------------
      if(req.method==='GET' && url.pathname==='/api/integrations/definitions') {
        authorize(session,['owner','operator']);
        return send(200,listIntegrationDefinitions(store.db));
      }
      // Universal Integration Platform (Phase 6D, Part 26/27/39/40) — the data-driven
      // marketplace: PUBLISHED connectors only (a DRAFT one 404s/never appears here, a
      // DISABLED one is excluded too — `getTenantCatalog` filters on real `status`), safe
      // metadata only. This is the ONE source the Control Center's Integrations tab reads for
      // "what can this tenant connect" — a newly Builder-published connector needs zero
      // frontend code change to appear here.
      if(req.method==='GET' && url.pathname==='/api/integrations/catalog') {
        authorize(session,['owner','operator']);
        return send(200,getTenantCatalog(store.db,session.tenantId));
      }
      // Phase 6G, Part 28-38 — Tenant Custom Connector Governance (tenant-facing half; the
      // Platform Admin review-queue routes live earlier, alongside the other Platform Admin
      // routes, since they are deliberately tenant-independent).
      if(req.method==='GET' && url.pathname==='/api/integrations/custom-connectors') {
        authorize(session,['owner']);
        return send(200,{enabled:tenantCustomConnectorsEnabled(env),connectors:listOwnTenantConnectors(store.db,session.tenantId)});
      }
      if(req.method==='POST' && url.pathname==='/api/integrations/custom-connectors') {
        authorize(session,['owner']);
        const created=createTenantConnectorDraft(store.db,env,session.user,session.tenantId,await body(req));
        recordAudit(store.db,{id:crypto.randomUUID(),action:'TENANT_CONNECTOR_DRAFT_CREATED',itemId:created.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(201,created);
      }
      const customConnectorItem=url.pathname.match(/^\/api\/integrations\/custom-connectors\/([\w-]+)$/);
      if(req.method==='PATCH' && customConnectorItem) {
        authorize(session,['owner']);
        return send(200,updateTenantConnectorDraft(store.db,env,session.tenantId,customConnectorItem[1],await body(req)));
      }
      const customConnectorActions=url.pathname.match(/^\/api\/integrations\/custom-connectors\/([\w-]+)\/actions$/);
      if(req.method==='GET' && customConnectorActions) {
        authorize(session,['owner']);
        return send(200,listTenantConnectorActions(store.db,session.tenantId,customConnectorActions[1]));
      }
      if(req.method==='POST' && customConnectorActions) {
        authorize(session,['owner']);
        return send(201,upsertTenantConnectorAction(store.db,env,session.tenantId,customConnectorActions[1],await body(req)));
      }
      const customConnectorActionItem=url.pathname.match(/^\/api\/integrations\/custom-connectors\/([\w-]+)\/actions\/([\w-]+)$/);
      if(req.method==='DELETE' && customConnectorActionItem) {
        authorize(session,['owner']);
        deleteTenantConnectorAction(store.db,env,session.tenantId,customConnectorActionItem[1],customConnectorActionItem[2]);
        return send(200,{ok:true});
      }
      // Phase 6H, Part 26-32 — Tenant Custom Connector Webhook Triggers.
      const customConnectorTriggers=url.pathname.match(/^\/api\/integrations\/custom-connectors\/([\w-]+)\/triggers$/);
      if(req.method==='GET' && customConnectorTriggers) {
        authorize(session,['owner']);
        return send(200,listTenantConnectorTriggers(store.db,session.tenantId,customConnectorTriggers[1]));
      }
      if(req.method==='POST' && customConnectorTriggers) {
        authorize(session,['owner']);
        return send(201,upsertTenantConnectorTrigger(store.db,env,session.tenantId,customConnectorTriggers[1],await body(req)));
      }
      const customConnectorTriggerItem=url.pathname.match(/^\/api\/integrations\/custom-connectors\/([\w-]+)\/triggers\/([\w-]+)$/);
      if(req.method==='DELETE' && customConnectorTriggerItem) {
        authorize(session,['owner']);
        deleteTenantConnectorTrigger(store.db,env,session.tenantId,customConnectorTriggerItem[1],customConnectorTriggerItem[2]);
        return send(200,{ok:true});
      }
      const customConnectorSubmit=url.pathname.match(/^\/api\/integrations\/custom-connectors\/([\w-]+)\/submit$/);
      if(req.method==='POST' && customConnectorSubmit) {
        authorize(session,['owner']);
        const submitted=submitTenantConnectorForReview(store.db,env,session.tenantId,customConnectorSubmit[1]);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'TENANT_CONNECTOR_SUBMITTED',itemId:submitted.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,submitted);
      }
      // Phase 6G, Part 43-47 — Agent Connection Map + Tool Compatibility View.
      if(req.method==='GET' && url.pathname==='/api/agent-connection-map') {
        authorize(session,['owner','operator']);
        return send(200,buildAgentConnectionMap(store.db,env,session.tenantId,{
         agentId:url.searchParams.get('agentId')||null,connectorSlug:url.searchParams.get('connectorSlug')||null,
         status:url.searchParams.get('status')||null,capability:url.searchParams.get('capability')||null,
         health:url.searchParams.get('health')||null
        }));
      }
      if(req.method==='GET' && url.pathname==='/api/tool-compatibility') {
        authorize(session,['owner','operator']);
        return send(200,buildToolCompatibilityView(store.db,env,session.tenantId));
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/connections') {
        authorize(session,['owner','operator']);
        const connections=listConnections(store.db,{integrationDefinitionId:url.searchParams.get('provider')||undefined},session.tenantId);
        // Phase 6G, Part 25-27 — Reauth UX: an additive, computed `healthView` field
        // (displayStatus/tokenExpiry) alongside the real, unchanged `status` column — never a
        // replacement for it.
        return send(200,connections.map(c=>({...c,healthView:buildConnectionHealthView(store.db,env,c,getIntegrationDefinition(store.db,c.integrationDefinitionId))})));
      }
      if(req.method==='POST' && url.pathname==='/api/integrations/connections') {
        authorize(session,['owner']);
        const input=await body(req);
        if(typeof input.integrationDefinitionId!=='string')fail(400,'integrationDefinitionId مطلوب');
        const connection=createConnection(store.db,{integrationDefinitionId:input.integrationDefinitionId,name:typeof input.name==='string'&&input.name.trim()?input.name.trim():'اتصال جديد',connectedBy:session.user.id},session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'INTEGRATION_CONNECTION_CREATED',itemId:connection.id,provider:connection.integrationDefinitionId,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(201,connection);
      }
      const connectionItem=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)$/);
      if(req.method==='GET' && connectionItem) {
        authorize(session,['owner','operator']);
        const connection=getConnection(store.db,connectionItem[1],session.tenantId);
        return send(200,{...connection,healthView:buildConnectionHealthView(store.db,env,connection,getIntegrationDefinition(store.db,connection.integrationDefinitionId))});
      }
      if(req.method==='PATCH' && connectionItem) {
        authorize(session,['owner']);
        const input=await body(req);
        if(typeof input.name!=='string'||!input.name.trim())fail(400,'name مطلوب');
        return send(200,updateConnection(store.db,connectionItem[1],{name:input.name.trim()},session.tenantId));
      }
      if(req.method==='DELETE' && connectionItem) {
        authorize(session,['owner']);
        const connection=deleteConnection(store.db,connectionItem[1],session.tenantId);
        removeCredential(store.db,connection.id,session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'INTEGRATION_CONNECTION_DELETED',itemId:connection.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,connection);
      }
      const connectionDisconnect=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/disconnect$/);
      if(req.method==='POST' && connectionDisconnect) {
        authorize(session,['owner']);
        const connection=disconnectConnection(store.db,connectionDisconnect[1],session.tenantId);
        removeCredential(store.db,connection.id,session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'INTEGRATION_CONNECTION_DISCONNECTED',itemId:connection.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,connection);
      }
      const connectionSetDefault=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/set-default$/);
      if(req.method==='POST' && connectionSetDefault) {
        authorize(session,['owner']);
        const connection=setDefaultConnection(store.db,connectionSetDefault[1],session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'INTEGRATION_CONNECTION_SET_DEFAULT',itemId:connection.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,connection);
      }
      // Phase 6G, Part 5-7 — Connection Version Migration/Rollback.
      const connectionVersionInfo=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/version$/);
      if(req.method==='GET' && connectionVersionInfo) {
        authorize(session,['owner','operator']);
        getConnection(store.db,connectionVersionInfo[1],session.tenantId); // 404s if wrong tenant
        return send(200,getConnectionVersionInfo(store.db,connectionVersionInfo[1],session.tenantId));
      }
      const connectionVersionPreview=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/version\/preview$/);
      if(req.method==='GET' && connectionVersionPreview) {
        authorize(session,['owner','operator']);
        return send(200,previewVersionMigration(store.db,session.tenantId,connectionVersionPreview[1],url.searchParams.get('target')));
      }
      const connectionVersionMigrate=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/version\/migrate$/);
      if(req.method==='POST' && connectionVersionMigrate) {
        authorize(session,['owner']);
        const input=await body(req);
        const result=await migrateConnectionVersion({db:store.db,env,fetcher,tenantId:session.tenantId,connectionId:connectionVersionMigrate[1],targetVersion:input.targetVersion});
        recordAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTION_VERSION_MIGRATED',itemId:result.connection.id,fromVersion:result.fromVersion,toVersion:result.toVersion,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,result);
      }
      const connectionVersionRollback=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/version\/rollback$/);
      if(req.method==='POST' && connectionVersionRollback) {
        authorize(session,['owner']);
        const result=await rollbackConnectionVersion({db:store.db,env,fetcher,tenantId:session.tenantId,connectionId:connectionVersionRollback[1]});
        recordAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTION_VERSION_ROLLED_BACK',itemId:result.connection.id,fromVersion:result.fromVersion,toVersion:result.toVersion,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,result);
      }
      // Phase 6G, Part 39/40 — per-connection Usage view.
      const connectionUsage=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/usage$/);
      if(req.method==='GET' && connectionUsage) {
        authorize(session,['owner','operator']);
        return send(200,getConnectionUsage(store.db,session.tenantId,connectionUsage[1],url.searchParams.get('window')||'7d'));
      }
      // Phase 6G, Part 9-17 — Webhook Console.
      const webhookConsole=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/webhook-console$/);
      if(req.method==='GET' && webhookConsole) {
        authorize(session,['owner','operator']);
        return send(200,getWebhookConsoleView(store.db,webhookConsole[1],session.tenantId,{baseUrl}));
      }
      const webhookRotateUrl=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/webhook\/rotate-url$/);
      if(req.method==='POST' && webhookRotateUrl) {
        authorize(session,['owner']);
        const newPublicId=rotateWebhookUrl(store.db,webhookRotateUrl[1],session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTOR_WEBHOOK_URL_ROTATED',itemId:webhookRotateUrl[1],actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,{url:`${baseUrl}/api/webhooks/connectors/${newPublicId}`});
      }
      const webhookRotateSecret=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/webhook\/rotate-secret$/);
      if(req.method==='POST' && webhookRotateSecret) {
        authorize(session,['owner']);
        const {webhookSecret}=rotateWebhookSecret(store.db,env,webhookRotateSecret[1],session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTOR_WEBHOOK_SECRET_ROTATED',itemId:webhookRotateSecret[1],actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        // Part 12 — shown to the operator exactly once; no route ever returns it again afterward.
        return send(200,{webhookSecret});
      }
      const webhookTest=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/webhook\/test$/);
      if(req.method==='POST' && webhookTest) {
        authorize(session,['owner','operator']);
        const input=await body(req);
        const result=await sendTestWebhookEvent({db:store.db,env,eventBus,connectionId:webhookTest[1],tenantId:session.tenantId,triggerSlug:input.triggerSlug,samplePayload:input.samplePayload});
        recordAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTOR_WEBHOOK_TEST_SENT',itemId:webhookTest[1],detail:result.status,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,result);
      }
      const webhookFailedList=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/webhook\/failed$/);
      if(req.method==='GET' && webhookFailedList) {
        authorize(session,['owner','operator']);
        return send(200,listFailedWebhookEventsForConnection(store.db,webhookFailedList[1],session.tenantId));
      }
      const webhookFailedDetail=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/webhook\/failed\/([\w-]+)$/);
      if(req.method==='GET' && webhookFailedDetail) {
        // Part 15 — Platform Admin OR the tenant owner of this exact connection; never any
        // other tenant's operator, and never a bare "operator" role (raw payload can carry
        // real customer data — owner-only, one notch stricter than the console's own GET/list).
        if(!isPlatformAdmin(env,session.user))authorize(session,['owner']);
        return send(200,getFailedWebhookEventDetail(store.db,webhookFailedDetail[1],session.tenantId,webhookFailedDetail[2]));
      }
      const webhookReprocess=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/webhook\/failed\/([\w-]+)\/reprocess$/);
      if(req.method==='POST' && webhookReprocess) {
        authorize(session,['owner']);
        const result=reprocessFailedWebhookEvent({db:store.db,eventBus,connectionId:webhookReprocess[1],tenantId:session.tenantId,eventId:webhookReprocess[2]});
        recordAudit(store.db,{id:crypto.randomUUID(),action:'CONNECTOR_WEBHOOK_REPROCESSED',itemId:webhookReprocess[2],actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,result);
      }
      // Universal Integration Platform (Phase 6C, Part 81) — a safe way for the tenant owner
      // to retrieve their own connection's real webhook URL. The public id GRANTS ROUTING,
      // never authentication (Part 83) — real security still depends on the trigger's own
      // HMAC/header-token verification once configured. Never returns a secret.
      const connectionWebhook=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/webhook$/);
      if(req.method==='GET' && connectionWebhook) {
        authorize(session,['owner','operator']);
        const connection=getConnection(store.db,connectionWebhook[1],session.tenantId);
        // Phase 6D — a dynamic (Builder-published) connector has no code-defined manifest, so
        // this MUST resolve through the same dynamic registry runtime uses, never the static-
        // only registry (which would silently report NOT_APPLICABLE for every Builder webhook).
        const manifest=resolveConnectorDynamic(store.db,connection.integrationDefinitionId,{connectorVersion:connection.connectorVersion??null})?.manifest||null;
        const triggers=manifest?.triggers||[];
        if(!triggers.length)return send(200,{url:null,status:'NOT_APPLICABLE',triggers:[]});
        const publicId=getOrCreateWebhookPublicId(store.db,connection.id,session.tenantId);
        return send(200,{
         url:`${baseUrl}/api/webhooks/connectors/${publicId}`,
         status:connection.status,
         triggers:triggers.map(t=>({slug:t.slug,name:t.name,authType:t.authentication.type}))
        });
      }
      // Universal Integration Platform (Phase 6D) — lets the tenant owner/operator run one of
      // a connection's own declared actions directly from the Connection UI (e.g. a manual
      // "Run get_invoices now"), through the EXACT SAME ConnectorRuntime pipeline the Agent
      // tool path already uses — capability/tenant/approval checks included, never a shortcut.
      // Item 16/17 — the Manual Action Runner / Action Test Console needs to know what actions
      // even EXIST for this connection's connector before it can offer a "Run" button — safe
      // metadata only (slug, method, path, risk, whether it needs approval), resolved through
      // the SAME dynamic registry ConnectorRuntime itself uses, never a second definition of
      // "what actions does this connector have".
      const connectionActionsList=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/actions$/);
      if(req.method==='GET' && connectionActionsList) {
        authorize(session,['owner','operator']);
        const connection=getConnection(store.db,connectionActionsList[1],session.tenantId);
        const manifest=resolveConnectorDynamic(store.db,connection.integrationDefinitionId,{connectorVersion:connection.connectorVersion??null})?.manifest||null;
        const actions=(manifest?.actions||[]).map(a=>({slug:a.slug,nameAr:a.nameAr,nameEn:a.nameEn,method:a.method,pathTemplate:a.rest?.pathTemplate||null,requiredCapability:a.requiredCapability,riskLevel:a.riskLevel,actionType:a.actionType,requiresApprovalDefault:a.requiresApprovalDefault,inputSchema:a.inputSchema}));
        return send(200,actions);
      }
      const connectionAction=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/actions\/([\w-]+)$/);
      if(req.method==='POST' && connectionAction) {
        authorize(session,['owner','operator']);
        const connection=getConnection(store.db,connectionAction[1],session.tenantId);
        const input=await body(req);
        const result=await executeConnectorAction({db:store.db,env,tenantId:session.tenantId,connectorSlug:connection.integrationDefinitionId,connectionId:connection.id,actionId:connectionAction[2],input:input?.input||{},actor:session.user});
        return send(200,result);
      }
      // Item 19 — Action History: safe metadata only (status, error code, latency, actor,
      // time — never the raw output/credential), reusing the EXISTING audit log rather than a
      // second, parallel action-log table. Filters the tenant's own recent audit rows in
      // memory rather than widening listAuditLog's own shared signature — a real, documented
      // scope boundary (fine at pilot scale; revisit with a dedicated indexed query well
      // before a tenant has thousands of audit rows).
      const connectionActionHistory=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/action-history$/);
      if(req.method==='GET' && connectionActionHistory) {
        authorize(session,['owner','operator']);
        const connection=getConnection(store.db,connectionActionHistory[1],session.tenantId);
        const relevant=new Set(['CONNECTOR_ACTION_EXECUTED','CONNECTOR_ACTION_FAILED','CONNECTOR_ACTION_PENDING_APPROVAL']);
        const recent=listAuditLog(store.db,{tenantId:session.tenantId,limit:300}).filter(a=>a.itemId===connection.id && relevant.has(a.action));
        return send(200,recent.slice(0,30).map(a=>({action:a.action,actionSlug:a.actionSlug,status:a.status,errorCode:a.errorCode||null,latencyMs:a.latencyMs??null,actorName:a.actorName,at:a.at})));
      }
      const connectionTest=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/test$/);
      if(req.method==='POST' && connectionTest) {
        authorize(session,['owner']);
        const connection=getConnection(store.db,connectionTest[1],session.tenantId);
        const result=await testConnectionHealth(connection,{store,env,fetcher});
        const now=new Date().toISOString();
        const updated=updateConnection(store.db,connection.id,{
         status:result.status,lastHealthCheck:now,
         lastSuccessAt:result.status==='CONNECTED'?now:connection.lastSuccessAt,
         lastErrorAt:(result.status==='ERROR'||result.status==='TOKEN_EXPIRED')?now:connection.lastErrorAt,
         lastErrorCode:result.errors?.[0]||null,lastErrorMessageSafe:result.safeMessage||null
        },session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'INTEGRATION_CONNECTION_TESTED',itemId:connection.id,result:result.status,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
        return send(200,{...result,connection:updated});
      }
      // Phase 6G, Part 18-26 — the ONE resolver every OAuth-flow route (reconnect/start/
      // callback) shares: a slug is OAuth-reconnectable exactly when it is either a fixed,
      // code-reviewed GENERIC_OAUTH_PROVIDERS entry (Salla/Zid) OR a real, PUBLISHED,
      // Platform-Admin-authored GENERIC_REST connector declaring `auth.type==='OAUTH2'` (Part
      // 23 — never a tenant-supplied URL; its authorizeUrl/tokenUrl were already SSRF/HTTPS-
      // validated at save time by validateOAuth2Config).
      const resolveOAuthProvider=(slug)=>{
       const builtIn=GENERIC_OAUTH_PROVIDERS[slug];
       if(builtIn)return builtIn;
       const definition=getIntegrationDefinition(store.db,slug);
       if(!definition||definition.adapterType!=='GENERIC_REST'||definition.status!=='PUBLISHED'||definition.authConfig?.type!=='OAUTH2')return null;
       const auth=definition.authConfig;
       const redirectUri=`${baseUrl}/api/integrations/oauth/${slug}/callback`;
       return {
        defaultConnectionName:definition.nameAr,isGenericDynamic:true,pkce:!!auth.pkce,
        createAuthorizeUrl:(env2,_userId,state,codeVerifier)=>createGenericAuthorizeUrl(auth,env2,state,{redirectUri,codeVerifier}),
        exchangeCodeForTokens:({env:env2,fetcher:f,code,codeVerifier})=>exchangeGenericCodeForTokens(auth,env2,f,{code,redirectUri,codeVerifier}),
        resolveIdentity:auth.identityEndpoint?({env:env2,fetcher:f,accessToken})=>resolveGenericIdentity(auth,env2,f,accessToken):null
       };
      };
      const connectionReconnect=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/reconnect$/);
      if(req.method==='POST' && connectionReconnect) {
        authorize(session,['owner']);
        const connection=getConnection(store.db,connectionReconnect[1],session.tenantId);
        const definition=getIntegrationDefinition(store.db,connection.integrationDefinitionId);
        if(definition?.authType==='API_KEY')fail(400,'أعد الربط عبر مسار بيانات الاعتماد (credential) لا عبر reconnect');
        // Phase 6G fix — this used to hardcode `!=='salla'`, silently refusing reconnect for
        // EVERY other OAuth2 connector (Zid included, and now any Generic OAuth2 connector) even
        // though the underlying `/oauth/:slug/start?connectionId=` flow already fully supports
        // reconnecting an existing connection (Part 26 — same logical connection, no duplicate).
        if(!resolveOAuthProvider(connection.integrationDefinitionId))fail(501,'إعادة الربط العامة غير متاحة بعد لهذا المزوّد — استخدم مسار الربط الحالي لهذا التكامل');
        return send(200,{reauthorizeUrl:`/api/integrations/oauth/${connection.integrationDefinitionId}/start?connectionId=${connection.id}`});
      }
      // API_KEY connect flow (Anthropic/OpenAI, Phase 26): backend tests the submitted key
      // for real BEFORE persisting anything — a failing key is never stored and the
      // connection is never marked CONNECTED. Response never echoes the key back.
      const connectionCredential=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/credential$/);
      if(req.method==='PUT' && connectionCredential) {
        authorize(session,['owner']);
        const connection=getConnection(store.db,connectionCredential[1],session.tenantId);
        const definition=getIntegrationDefinition(store.db,connection.integrationDefinitionId);
        if(!definition||definition.authType!=='API_KEY')fail(400,'هذا التكامل لا يُدار عبر مسار مفتاح API — استخدم تدفق OAuth الخاص به');
        const input=await body(req);
        if(typeof input.apiKey!=='string'||!input.apiKey.trim())fail(400,'apiKey مطلوب');
        const apiKey=input.apiKey.trim();
        const testEnv=connection.integrationDefinitionId==='anthropic'?{...env,ANTHROPIC_API_KEY:apiKey}:connection.integrationDefinitionId==='openai'?{...env,OPENAI_API_KEY:apiKey}:null;
        const testResult=connection.integrationDefinitionId==='anthropic'?await testAnthropicConnection({env:testEnv,fetcher})
         :connection.integrationDefinitionId==='openai'?await testOpenAIConnection({env:testEnv,fetcher})
         :{result:'NOT_CONFIGURED',code:'UNSUPPORTED_API_KEY_PROVIDER'};
        const now=new Date().toISOString();
        if(testResult.result!=='OK') {
         updateConnection(store.db,connection.id,{status:'ERROR',lastHealthCheck:now,lastErrorAt:now,lastErrorCode:testResult.code||testResult.result,lastErrorMessageSafe:testResult.code||testResult.result},session.tenantId);
         recordAudit(store.db,{id:crypto.randomUUID(),action:'CREDENTIAL_TEST_FAILED',itemId:connection.id,errorCode:testResult.code||testResult.result,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
         fail(422,`فشل اختبار المفتاح: ${testResult.code||testResult.result}`);
        }
        storeCredential(store.db,env,{connectionId:connection.id,credentialType:'api_key',payload:{apiKey}},session.tenantId);
        updateConnection(store.db,connection.id,{status:'CONNECTED',connectedBy:session.user.id,connectedAt:connection.connectedAt||now,lastHealthCheck:now,lastSuccessAt:now,lastErrorAt:null,lastErrorCode:null,lastErrorMessageSafe:null},session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'CREDENTIAL_CREATED',itemId:connection.id,provider:connection.integrationDefinitionId,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
        return send(200,getCredentialMeta(store.db,connection.id,session.tenantId));
      }
      // Universal Integration Platform (Phase 6D) — the Generic Connection UI's credential
      // route: ANY dynamic (GENERIC_REST/Builder-published) connector's API_KEY/BEARER_TOKEN/
      // BASIC/NONE auth, never Salla/Anthropic/OpenAI (those keep their own dedicated,
      // already-tested flows above/OAuth — this route 400s for them so the two paths can never
      // collide). Same real principle as the legacy /credential route: the submitted secret is
      // tested for REAL (via the same ConnectorRuntime health pipeline the Agent tool path
      // uses) BEFORE it is ever persisted or the connection marked CONNECTED — a failing
      // credential is never stored.
      const genericCredential=url.pathname.match(/^\/api\/integrations\/connections\/([\w-]+)\/generic-credential$/);
      if(req.method==='PUT' && genericCredential) {
        authorize(session,['owner']);
        const connection=getConnection(store.db,genericCredential[1],session.tenantId);
        const definition=getIntegrationDefinition(store.db,connection.integrationDefinitionId);
        if(!definition||definition.adapterType!=='GENERIC_REST')fail(400,'هذا المسار مخصص لموصلات REST العامة فقط — استخدم مسار الربط الخاص بهذا التكامل');
        const authType=definition.authConfig?.type;
        const input=await body(req);
        let credentialType,payload;
        if(authType==='API_KEY') {
         if(typeof input.apiKey!=='string'||!input.apiKey.trim())fail(400,'apiKey مطلوب');
         credentialType='api_key';payload={apiKey:input.apiKey.trim()};
        } else if(authType==='BEARER_TOKEN') {
         if(typeof input.token!=='string'||!input.token.trim())fail(400,'token مطلوب');
         credentialType='bearer_token';payload={token:input.token.trim()};
        } else if(authType==='BASIC') {
         if(typeof input.username!=='string'||!input.username.trim())fail(400,'username مطلوب');
         credentialType='basic_auth';payload={username:input.username.trim(),password:typeof input.password==='string'?input.password:''};
        } else if(authType==='NONE') {
         credentialType='none';payload={};
        } else {
         fail(400,'نوع مصادقة غير مدعوم لهذا المسار');
        }
        // Persist first so checkConnectorHealth's own credential lookup can see it — mirrors
        // the same order the direct-function integration-builder tests already prove is safe:
        // a failing real check still leaves the connection NOT CONNECTED (never silently
        // upgraded), and a re-submit simply overwrites the one row (Part 13's single-credential
        // per connection model), so no orphaned bad credential can ever linger unreported.
        storeCredential(store.db,env,{connectionId:connection.id,credentialType,payload},session.tenantId);
        const health=await checkConnectorHealth({db:store.db,env,tenantId:session.tenantId,connectorSlug:connection.integrationDefinitionId,connectionId:connection.id});
        const now=new Date().toISOString();
        if(health.status!=='OK') {
         updateConnection(store.db,connection.id,{status:health.status==='NOT_CONFIGURED'?'NOT_CONFIGURED':'ERROR',lastHealthCheck:now,lastErrorAt:now,lastErrorCode:health.errorCode||health.status,lastErrorMessageSafe:health.errorCode||health.status},session.tenantId);
         recordAudit(store.db,{id:crypto.randomUUID(),action:'CREDENTIAL_TEST_FAILED',itemId:connection.id,errorCode:health.errorCode||health.status,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
         fail(422,`فشل اختبار الاتصال: ${health.errorCode||health.status}`);
        }
        // Phase 6G — pin this connection to the connector's current PUBLISHED version at the
        // exact moment it first becomes CONNECTED (see the matching note on the generic OAuth
        // callback route; same real gap, same fix, same rationale — nothing before this phase
        // ever actually wrote this pin at connect time for ANY connection).
        updateConnection(store.db,connection.id,{status:'CONNECTED',connectedBy:session.user.id,connectedAt:connection.connectedAt||now,lastHealthCheck:now,lastSuccessAt:now,lastErrorAt:null,lastErrorCode:null,lastErrorMessageSafe:null,connectorVersion:definition.status==='PUBLISHED'?definition.version:connection.connectorVersion},session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'CREDENTIAL_CREATED',itemId:connection.id,provider:connection.integrationDefinitionId,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
        return send(200,getCredentialMeta(store.db,connection.id,session.tenantId));
      }
      // Generic OAuth start/callback — Salla and (Phase 6E) Zid, both real, approved,
      // platform-managed OAuth2 flows. Deliberately a SEPARATE path
      // (/api/integrations/oauth/:slug/...) from the existing /api/integrations/salla/oauth/...
      // routes so the two flows never collide: the old route always operates on Salla's single
      // mirrored "default" connection, this one can create/refresh any specific connection
      // (Phase 54's multi-store proof). Every provider here is a fixed, code-reviewed entry in
      // GENERIC_OAUTH_PROVIDERS below — a tenant never supplies its own authorize/token URL
      // (Part 3 of Phase 6E: "No Generic Unsafe OAuth").
      // Phase 6G, Part 18-24 — `resolveOAuthProvider` (defined once above, near the reconnect
      // route) already covers a Generic OAuth2 connector too — a brand-new one never needs a
      // code change here.
      const genericOAuthStart=url.pathname.match(/^\/api\/integrations\/oauth\/([\w-]+)\/start$/);
      if(req.method==='GET' && genericOAuthStart) {
        authorize(session,['owner']);
        const slug=genericOAuthStart[1];
        const provider=resolveOAuthProvider(slug);
        if(!provider)fail(501,'تدفق الربط العام (متعدد الاتصالات) غير متاح بعد لهذا التكامل — استخدم مسار الربط الحالي');
        if(!getIntegrationDefinition(store.db,slug))fail(400,'تكامل غير معروف');
        const existingId=url.searchParams.get('connectionId')||null;
        const connection=existingId
         ?getConnection(store.db,existingId,session.tenantId)
         :createConnection(store.db,{integrationDefinitionId:slug,name:url.searchParams.get('name')||provider.defaultConnectionName,connectedBy:session.user.id},session.tenantId);
        // Part 22 — PKCE verifier generated once here and bound to the state row itself
        // (oauth-state.js already supports this — encrypted at rest, single-use, tenant/user-
        // bound); only a connector that actually declared `auth.pkce:true` ever uses this path.
        const codeVerifier=provider.pkce?cryptoRandomBytes(32).toString('base64url'):null;
        const stateToken=createOAuthState(store.db,{tenantId:session.tenantId,userId:session.user.id,integrationDefinitionId:slug,connectionId:connection.id,pkceVerifier:codeVerifier},env);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'OAUTH_STARTED',itemId:connection.id,provider:slug,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        res.writeHead(302,{Location:provider.createAuthorizeUrl(env,session.user.id,stateToken,codeVerifier)});return res.end();
      }
      const genericOAuthCallback=url.pathname.match(/^\/api\/integrations\/oauth\/([\w-]+)\/callback$/);
      if(req.method==='GET' && genericOAuthCallback) {
        authorize(session,['owner']);
        const slug=genericOAuthCallback[1];
        const provider=resolveOAuthProvider(slug);
        if(!provider)fail(501,'تدفق الربط العام (متعدد الاتصالات) غير متاح بعد لهذا التكامل');
        const code=url.searchParams.get('code'),state=url.searchParams.get('state');
        if(!code||!state)fail(400,'استجابة ربط ناقصة (code/state)');
        let consumed;
        try{consumed=consumeOAuthState(store.db,state,{userId:session.user.id,integrationDefinitionId:slug},env);}
        catch(error){
         recordAudit(store.db,{id:crypto.randomUUID(),action:'OAUTH_FAILED',itemId:slug,errorCode:error.code||'OAUTH_STATE_INVALID',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
         throw error;
        }
        if(consumed.tenantId!==session.tenantId)fail(403,'طلب الربط لا يخص هذه المنشأة');
        const tokens=await provider.exchangeCodeForTokens({env,fetcher,code,codeVerifier:consumed.pkceVerifier});
        storeCredential(store.db,env,{connectionId:consumed.connectionId,credentialType:'oauth_tokens',payload:{accessToken:tokens.accessToken,refreshToken:tokens.refreshToken,expiresAt:tokens.expiresAt}},session.tenantId);
        // Phase 6G — a GENERIC_REST OAUTH2 connection is pinned to the connector's current
        // PUBLISHED version at the exact moment it first becomes connected (Part 42/108/109 of
        // Phase 6D's own versioning policy — nothing before this phase ever actually wrote this
        // pin at connect time, see the `updateConnection` fix in integrations/connections.js).
        const connectDefinition=getIntegrationDefinition(store.db,slug);
        const connectorVersionPin=connectDefinition?.adapterType==='GENERIC_REST'?connectDefinition.version:undefined;
        // Phase 6E, Part 21 — Zid's real, documented, read-only identity endpoint
        // (GET /v1/managers/account/profile) is called right after a successful token
        // exchange so `externalAccountId`/`externalAccountName` are resolved honestly instead
        // of staying null forever (the pre-existing, still-unresolved Salla gap this comment
        // used to describe is untouched — Salla still has no live app in this environment to
        // verify a profile call against, so it is deliberately left exactly as it was).
        let identity={};
        if(provider.resolveIdentity){
         try{identity=await provider.resolveIdentity({env,fetcher,accessToken:tokens.accessToken})||{};}
         catch{identity={};}
        }
        const now=new Date().toISOString();
        const connection=updateConnection(store.db,consumed.connectionId,{
         status:'CONNECTED',externalAccountType:slug,scopes:tokens.scopes,
         ...(identity.externalAccountId?{externalAccountId:identity.externalAccountId}:{}),
         ...(identity.externalAccountName?{externalAccountName:identity.externalAccountName}:{}),
         ...(connectorVersionPin!==undefined?{connectorVersion:connectorVersionPin}:{}),
         connectedBy:session.user.id,connectedAt:now,lastSuccessAt:now,lastErrorAt:null,lastErrorCode:null,lastErrorMessageSafe:null
        },session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'OAUTH_COMPLETED',itemId:connection.id,provider:slug,actorId:session.user.id,actorName:session.user.name,at:now},session.tenantId);
        res.writeHead(302,{Location:'/app#integrations'});return res.end();
      }
      // Manual reply outside the agent runtime — same permission/opt-out/approval-category
      // checks as the microsoft_sendEmail agent tool, never a second, looser path.
      const manualEmailSend=url.pathname.match(/^\/api\/crm\/leads\/([\w-]+)\/email-send$/);
      if(req.method==='POST' && manualEmailSend) {
        authorize(session,['owner','operator']);
        const id=manualEmailSend[1],input=await body(req);
        const lead=getLead(store.db,id,session.tenantId);
        if(lead.optOut)fail(409,'العميل أوقف التواصل (opt-out)');
        if(lead.humanHold)fail(409,'المحادثة موقوفة بانتظار مراجعة بشرية');
        if(!lead.email)fail(409,'لا يوجد بريد إلكتروني لهذا العميل');
        if(!input.subject||!input.bodyHtml)fail(400,'العنوان والنص مطلوبان');
        const category=input.category||'general';
        if(['quote','discount','large_b2b','legal'].includes(category)) {
         const approval=createApproval(store.db,{runId:null,agentId:'human',actionType:'send_marketing_message',
          proposedOutput:{leadId:id,to:lead.email,cc:input.cc||[],subject:input.subject,bodyHtml:input.bodyHtml,category},
          riskLevel:category==='legal'?'HIGH':'MEDIUM',reason:`${session.user.name} drafted a ${category} email to ${lead.email} — requires owner approval before sending.`,tenantId:session.tenantId});
         return send(200,{status:'WAITING_APPROVAL',approvalId:approval.id});
        }
        const result=await sendMail({store,env,fetcher},{to:lead.email,cc:input.cc,subject:input.subject,bodyHtml:input.bodyHtml},session.tenantId);
        if(result.status==='SENT')recordChannelMessage(store,{leadId:id,channel:'Email',direction:'OUTBOUND',text:input.bodyHtml,subject:input.subject,cc:input.cc||null,messageType:'email'},session.user,session.tenantId);
        return send(200,result);
      }
      if(req.method==='GET' && url.pathname==='/api/memory') return send(200,listMemory(store.db,session.tenantId));
      if(req.method==='GET' && url.pathname==='/api/memory/dashboard') return send(200,buildMemoryWorkspace(store,{pendingApprovals:listApprovals(store.db,{status:'PENDING'},session.tenantId).filter(a=>a.action_type==='memory_policy_change')}));
      if(req.method==='GET' && url.pathname==='/api/memory/usage') return send(200,computeMemoryUsage(store.db,url.searchParams.get('key')||'',session.tenantId));
      if(req.method==='POST' && url.pathname==='/api/memory') {
        authorize(session,['owner']);
        const input=await body(req);
        return send(201,store.mutate(()=>{const entry=saveMemory(store.db,input,session.user,session.tenantId);recordAudit(store.db,{id:crypto.randomUUID(),action:'MEMORY_VERSION_SAVED',itemId:entry.id,actorId:session.user.id,actorName:session.user.name,at:entry.verifiedAt},session.tenantId);return entry;}));
      }
      if(req.method==='POST' && url.pathname==='/api/memory/propose') {
        authorize(session,['owner','operator']);
        return send(201,proposeMemoryUpdate(store.db,await body(req),session.user,session.tenantId));
      }
      if(req.method==='GET' && url.pathname==='/api/products') return send(200,listProducts(store.db,session.tenantId));
      if(req.method==='POST' && url.pathname==='/api/salla/sync') {
        authorize(session,['owner']);
        if(syncing)fail(409,'مزامنة سلة قيد التنفيذ');
        syncing=true;
        try{const resolved=await resolveSallaAccessToken({store,env,fetcher},session.tenantId);const products=await importSalla({env,fetcher,accessToken:resolved?.token});store.mutate(()=>{replaceProducts(store.db,products,false,session.tenantId);recordAudit(store.db,{id:crypto.randomUUID(),action:'SALLA_CATALOG_SYNCED',itemId:'catalog',count:products.length,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);});return send(200,{count:products.length,syncedAt:new Date().toISOString()});}
        catch(error){recordAudit(store.db,{id:crypto.randomUUID(),action:'SALLA_CATALOG_SYNC_FAILED',itemId:'catalog',errorCode:error instanceof ConnectorError?error.code:'UNKNOWN',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);throw error;}
        finally{syncing=false;}
      }
      if(req.method==='GET' && url.pathname==='/api/ai/runs') return send(200,listAiRuns(store.db,50,session.tenantId));
      if(req.method==='GET' && url.pathname==='/api/content/dashboard') return send(200,buildContentWorkspace(store,{complianceByContent:latestComplianceByContent(store.db,session.tenantId),tenantId:session.tenantId}));
      if(req.method==='POST' && url.pathname==='/api/ai/draft') {
        authorize(session,['owner','operator']);
        checkLlmRateLimit(session.user.id);
        return send(200,await generate(await body(req),session.user,session.tenantId));
      }
      // Content Unification: this route backs the legacy flat "Content" review/approve page
      // (public/app.js's #items rendering), built entirely around the legacy review{}/
      // approval{} hash-pin shape (e.g. `item.review.reviewer`). Campaign-originated rows
      // (item.hook!==undefined) now live in the SAME content_items table but use a different
      // shape/lifecycle with their own dedicated UI in Marketing — including them here would
      // render broken cards (item.review is undefined for them), not just unrelated ones.
      if(req.method==='GET' && url.pathname==='/api/state') return send(200,{...store.read(),content:listContent(store.db,session?.tenantId).filter(item=>!isCampaignShaped(item)),audit:listAuditLog(store.db,{tenantId:session?.tenantId})});
      if(url.pathname.startsWith('/api/crm')) {
        authorize(session,['owner','operator']);
        if(req.method==='GET' && url.pathname==='/api/crm')return send(200,{leads:listLeads(store.db,session.tenantId),followups:listFollowups(store.db,session.tenantId),sequences:Object.entries(sequences).map(([id,sequence])=>({id,name:sequence.name,stages:sequence.stages})),staff:store.db.prepare("SELECT u.id,u.name,tm.role AS role FROM users u JOIN tenant_memberships tm ON tm.user_id=u.id WHERE tm.tenant_id=? AND tm.status='active' AND tm.role IN ('owner','operator') ORDER BY u.name").all(session.tenantId),channelsConnected:false});
        if(req.method==='GET' && url.pathname==='/api/crm/dashboard')return send(200,buildSalesDashboard(store,{agentRuns:listRuns(store.db,{limit:2000},session.tenantId),env,tenantId:session.tenantId}));
        if(req.method==='GET' && url.pathname==='/api/crm/search')return send(200,searchLeads(store.db,url.searchParams.get('q'),20,session.tenantId));
        if(req.method==='POST' && url.pathname==='/api/crm/leads'){const lead=createLead(store,await body(req),session.user,session.tenantId);eventBus.emit('LEAD_CREATED',{leadId:lead.id,customerType:lead.customerType,sourceType:lead.sourceType,tenantId:session.tenantId});return send(201,lead);}
        if(req.method==='POST' && url.pathname==='/api/crm/followups/prepare'){authorize(session,['owner']);return send(200,prepareFollowups(store,session.user,Date.now(),session.tenantId));}
        const approval=url.pathname.match(/^\/api\/crm\/followups\/([\w-]+)\/approve$/);
        if(req.method==='POST' && approval){authorize(session,['owner']);return send(200,approveFollowup(store,approval[1],session.user,session.tenantId));}
        const leadRoute=url.pathname.match(/^\/api\/crm\/leads\/([\w-]+)(?:\/(update|messages|contact|followups|stop-followups))?$/);
        if(leadRoute){
          if(req.method==='GET' && !leadRoute[2])return send(200,leadDetail(store.db,leadRoute[1],session.tenantId));
          if(req.method==='POST'){
            const input=await body(req),id=leadRoute[1],user=session.user;
            if(leadRoute[2]==='update'){
              const before=getLead(store.db,id,session.tenantId);
              const updated=updateLead(store,id,input,user,session.tenantId);
              maybeEscalateHotLead(store,eventBus,before,updated,{agentId:'human',tenantId:session.tenantId});
              return send(200,updated);
            }
            if(leadRoute[2]==='messages'){
              const message=recordMessage(store,id,input,user,session.tenantId);
              if(!message.replayed && message.direction==='INBOUND'){
                eventBus.emit('CUSTOMER_MESSAGE_RECEIVED',{leadId:id,channel:message.channel,text:message.text,tenantId:session.tenantId});
                if(message.optedOut)eventBus.emit('CUSTOMER_OPTED_OUT',{leadId:id,channel:message.channel,tenantId:session.tenantId});
              }
              return send(201,message);
            }
            if(leadRoute[2]==='contact')return send(200,contactControl(store,id,input,user,session.tenantId));
            if(leadRoute[2]==='followups')return send(201,createFollowups(store,id,input,user,session.tenantId));
            if(leadRoute[2]==='stop-followups')return send(200,cancelFollowups(store,id,user,session.tenantId));
          }
        }
        fail(404,'مسار CRM غير موجود');
      }
      if(req.method==='GET' && url.pathname==='/api/planning') {
        const publishingIntegrations=integrationStatus(env,store.db,session.tenantId);
        // Phase 4C-1 dangerous-pattern audit (Part Q) found this query with NO tenant_id
        // filter at all, despite `daily_briefs` being a real per-tenant table (Phase 3) —
        // a genuine cross-tenant leak, unreachable before a second tenant existed, exactly
        // the class of pre-existing gap this phase's own audit exists to surface and close.
        // Content Unification — `content` is additive (existing consumers unaffected): the
        // Global Calendar now reads the SAME canonical content_items store campaign content
        // lives in too, via listContentFiltered, optionally narrowed by query params so this
        // one page can filter by campaign/platform/content-type/status/date-range.
        const filters={campaignId:url.searchParams.get('campaignId')||undefined,platform:url.searchParams.get('platform')||undefined,format:url.searchParams.get('format')||undefined,status:url.searchParams.get('status')||undefined,dateFrom:url.searchParams.get('dateFrom')||undefined,dateTo:url.searchParams.get('dateTo')||undefined};
        const hasFilters=Object.values(filters).some(Boolean);
        return send(200,{slots:listSlots(store.db,session?.tenantId),jobs:listJobs(store.db,session?.tenantId),brief:buildBrief(store,undefined,session?.tenantId),savedBriefs:store.db.prepare('SELECT json FROM daily_briefs WHERE tenant_id=? ORDER BY date DESC LIMIT 14').all(session.tenantId).map(row=>JSON.parse(row.json)),today:riyadhDate(),automationConfigured:!!(env.AUTOMATION_TOKEN?.length>=32),publishingConnected:['meta','x','linkedin'].some(id=>publishingIntegrations[id]?.configured),content:hasFilters?listContentFiltered(store.db,session?.tenantId,filters):listContent(store.db,session?.tenantId)});
      }
      if(req.method==='POST' && url.pathname==='/api/calendar') {authorize(session,['owner','operator']);return send(201,createCalendar(store,(await body(req)).startDate,session.user,session.tenantId));}
      if(req.method==='POST' && url.pathname==='/api/schedule') {authorize(session,['owner']);return send(201,scheduleContent(store,await body(req),session.user,undefined,session.tenantId));}
      if(req.method==='POST' && url.pathname==='/api/schedule/prepare') {authorize(session,['owner']);return send(200,prepareDue(store,session.user,Date.now(),eventBus,env,session.tenantId));}
      if(req.method==='POST' && url.pathname==='/api/brief') {authorize(session,['owner']);return send(200,saveDailyBrief(store,riyadhDate(),session.user,session.tenantId));}
      // `?weekStart=` lets the UI view (and export) any past Sunday on demand, not only the
      // current week or an explicitly-saved one — buildWeeklyReport already rejects a non-Sunday
      // date with its own Arabic message, so only the "not a future week" guard is added here.
      function resolveReportWeekStart() {
        const requested=url.searchParams.get('weekStart');
        if(!requested)return currentWeekStart();
        if(requested>currentWeekStart())fail(400,'لا يمكن عرض تقرير لأسبوع مستقبلي');
        return requested;
      }
      if(req.method==='GET' && url.pathname==='/api/reports/weekly')return send(200,{current:buildExecutiveReport(store,resolveReportWeekStart(),{...reportExtras(session.tenantId),tenantId:session.tenantId}),saved:listWeeklyReports(store.db,session.tenantId)});
      if(req.method==='POST' && url.pathname==='/api/reports/weekly') {authorize(session,['owner']);const input=await body(req);return send(201,saveWeeklyReport(store,input.weekStart||currentWeekStart(),session.user,reportExtras(session.tenantId),session.tenantId));}
      if(req.method==='GET' && (url.pathname==='/api/reports/weekly/export.xlsx'||url.pathname==='/api/reports/weekly/export.pdf')) {
        const isXlsx=url.pathname.endsWith('.xlsx');
        const weekStart=resolveReportWeekStart();
        const locale=url.searchParams.get('locale')==='en'?'en':'ar';
        const report=buildExecutiveReport(store,weekStart,{...reportExtras(session.tenantId),tenantId:session.tenantId});
        const buffer=isXlsx?Buffer.from(await (await buildReportWorkbook(report,{locale})).xlsx.writeBuffer()):await buildReportPdfBuffer(report,{locale});
        const contentType=isXlsx?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/pdf';
        res.writeHead(200,{'Content-Type':contentType,'Content-Disposition':`attachment; filename="frost-report-${weekStart}.${isXlsx?'xlsx':'pdf'}"`,'Cache-Control':'no-store'});
        res.end(buffer);
        logRequest({request_id:requestId,method:req.method,path:req.url.split('?')[0],status:200,duration_ms:Date.now()-startedAt,user_id:userId});
        return;
      }
      if(req.method==='POST' && url.pathname==='/api/schedule/cancel') {authorize(session,['owner']);const input=await body(req);if(typeof input.contentId!=='string')fail(400,'معرف المحتوى مطلوب');return send(200,store.mutate(state=>cancelJobs(store,state,input.contentId,session.user,session.tenantId)));}
      const log=(action,item)=>recordAudit(store.db,{id:crypto.randomUUID(),action,itemId:item.id,actorId:session.user.id,actorName:session.user.name,actorRole:session.user.role,at:new Date().toISOString()},session.tenantId);
      if(req.method==='POST' && url.pathname==='/api/content') {
        authorize(session,['owner','operator']);
        const input=await body(req);
        return send(201,store.mutate(()=>{const item={...createContent(input),createdBy:session.user.id};insertContent(store.db,item,session.tenantId);log('DRAFT_CREATED',item);return item;}));
      }
      const change=url.pathname.match(/^\/api\/content\/([\w-]+)\/(revise|reject)$/);
      if(req.method==='POST' && change) {
        authorize(session,change[2]==='revise'?['owner','operator']:['owner','reviewer']);
        const input=await body(req);
        if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>1000)fail(400,'سبب التعديل أو الرفض مطلوب (حتى 1000 حرف)');
        return send(200,store.mutate(state=>{
          const current=getContent(store.db,change[1],session.tenantId);
          if(current.status==='SUPERSEDED')fail(409,'توجد نسخة أحدث من هذا المحتوى');
          if(current.status==='APPROVED' && session.user.role!=='owner')fail(403,'تغيير المحتوى المعتمد متاح للمالك فقط');
          if(change[2]==='reject' && current.status==='REJECTED')fail(409,'المحتوى مرفوض بالفعل');
          const revised=change[2]==='revise'?{...createContent(input),createdBy:session.user.id,parentId:current.id,revision:(current.revision||1)+1}:null;
          cancelJobs(store,state,current.id,session.user,session.tenantId);
          current.status=revised?'SUPERSEDED':'REJECTED';current.changeReason=input.reason.trim();current.changedBy=session.user.id;
          writeContent(store.db,current);
          if(revised)insertContent(store.db,revised,session.tenantId);
          log(revised?'CONTENT_REVISED':'CONTENT_REJECTED',current);return revised||current;
        }));
      }
      const match=url.pathname.match(/^\/api\/content\/([\w-]+)\/(review|approve)$/);
      if(req.method==='POST' && match) {
        authorize(session,match[2]==='review'?['owner','reviewer']:['owner']);
        const input=await body(req);
        return send(200,store.mutate(()=>{
          const current=getContent(store.db,match[1],session.tenantId);
          if(match[2]==='approve' && (!current.review?.userId || current.legacyUnauthenticated)) fail(409,'المراجعة القديمة غير موثقة بحساب؛ أنشئ مسودة جديدة للمراجعة');
          const item=match[2]==='review'?reviewContent(current,{...input,reviewer:session.user.name}):approveContent(current,{owner:session.user.name});
          if(match[2]==='review') {item.review.userId=session.user.id;item.legacyUnauthenticated=false;} else item.approval.userId=session.user.id;
          writeContent(store.db,item);log(match[2]==='review'?'COMPLIANCE_REVIEWED':'OWNER_APPROVED',item);
          if(match[2]==='approve')queueMicrotask(()=>eventBus.emit('CONTENT_APPROVED',{contentId:item.id,platform:item.platform,tenantId:session.tenantId}));
          return item;
        }));
      }
      const compliance=url.pathname.match(/^\/api\/content\/([\w-]+)\/compliance$/);
      if(compliance) {
        authorize(session,['owner','reviewer']);
        if(req.method==='GET')return send(200,listComplianceChecks(store.db,compliance[1],session.tenantId));
        if(req.method==='POST') {
          checkLlmRateLimit(session.user.id);
          return send(200,await checkCompliance(compliance[1],await body(req),session.user,session.tenantId));
        }
      }
      // Public marketing home (requested: the platform's public-facing page) — served at the
      // domain root. The existing admin tool (login + dashboard SPA) is UNCHANGED, just moved
      // to /app so both are reachable; every email link and OAuth-callback redirect that used
      // to point at '/#...' now points at '/app#...' (grepped for every real occurrence —
      // 12 call sites — rather than guessed).
      const files={'/favicon.svg':'favicon.svg','/':'home.html','/styles.css':'styles.css','/agent-network.js':'agent-network.js','/assets/screenshots/hero-marketing-overview.png':'assets/screenshots/hero-marketing-overview.png','/assets/screenshots/feature-command-center.png':'assets/screenshots/feature-command-center.png','/assets/screenshots/feature-crm.png':'assets/screenshots/feature-crm.png','/app':'index.html','/app.js':'app.js','/knowledge.js':'knowledge.js','/planning.js':'planning.js','/crm.js':'crm.js','/compliance.js':'compliance.js','/autonomy.js':'autonomy.js','/reporting.js':'reporting.js','/format.js':'format.js','/content.js':'content.js','/memory.js':'memory.js','/integrations.js':'integrations.js','/team.js':'team.js','/style.css':'style.css','/site.webmanifest':'site.webmanifest','/i18n.js':'i18n.js','/icons/icon-192.png':'icons/icon-192.png','/icons/icon-512.png':'icons/icon-512.png','/icons/icon-maskable-512.png':'icons/icon-maskable-512.png','/icons/apple-touch-icon.png':'icons/apple-touch-icon.png'};
      for(const file of ['components/ui/index.js','components/layout/app-shell.js','components/workspace-switcher.js','pages/workspace.js','pages/control-center.js','pages/invite.js','pages/onboarding.js','pages/account.js','pages/recovery.js','pages/new-workspace.js','pages/platform.js','pages/command-center.js','pages/workflows.js','pages/marketing.js','pages/whatsapp.js',...['fonts','tokens','base','components','layout','pages'].map(name=>'styles/'+name+'.css')])files['/'+file]=file;
      for(const loc of ['ar','en'])for(const domain of ['common','navigation','overview','sales','calendar','weeklyReport','content','agents','memory','integrations','operationsLog','team','forms','validation','statuses','errors','workspace','controlCenter','invitations','onboarding','account','platform','commandCenter','workflows','marketing','whatsapp','partnerships','customers'])files[`/locales/${loc}/${domain}.json`]=`locales/${loc}/${domain}.json`;
      // Website AI Chat Widget embed script (spec Part 87) — served publicly, unauthenticated,
      // exactly like /app.js already is; the ONE file a tenant embeds on their OWN external
      // website. Carries no secret — only the public, non-secret widget id the tenant pastes
      // into its own data attribute.
      files['/widget-embed.js']='widget-embed.js';
      for(const page of PORTAL_PAGES)files[page]='partners.html';
      for(const file of ['app','api','ui','i18n','pages-public','pages-partner'])files[`/partner-portal/${file}.js`]=`partner-portal/${file}.js`;
      files['/partner-portal/portal.css']='partner-portal/portal.css';
      for(const loc of ['ar','en'])files[`/partner-portal/i18n/${loc}.json`]=`partner-portal/i18n/${loc}.json`;
      files['/pages/partnerships.js']='pages/partnerships.js';
      files['/pages/customers.js']='pages/customers.js';
      for(const file of ['app','pages','pages-work','pages-account','kit'])files[`/client-portal/${file}.js`]=`client-portal/${file}.js`;
      files['/client-portal/client.css']='client-portal/client.css';
      for(const loc of ['ar','en'])files[`/client-portal/i18n/${loc}.json`]=`client-portal/i18n/${loc}.json`;
      if(req.method==='GET' && (url.pathname==='/client' || url.pathname.startsWith('/client/')))files[url.pathname]='client.html';
      files['/site-nav.js']='site-nav.js';
      files['/portal-brand.css']='portal-brand.css';
      files['/assets/og-frost.png']='assets/og-frost.png';
      for(const weight of [400,500,600,700])for(const subset of ['arabic','latin'])files[`/fonts/ibm-plex-sans-arabic-${weight}-${subset}.woff2`]=`fonts/ibm-plex-sans-arabic-${weight}-${subset}.woff2`;
      if(req.method==='GET' && (url.pathname==='/robots.txt'||url.pathname==='/sitemap.xml')) {
        // Crawlers: the marketing page is indexable, the dashboard and API are not. The sitemap
        // needs an absolute URL, so it only exists once PUBLIC_ORIGIN is configured.
        const origin=publicOriginOf(env);
        if(url.pathname==='/sitemap.xml' && !origin)return send(404,{error:'Not found'});
        const text=url.pathname==='/robots.txt'
          ?`User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /partners/\nDisallow: /client/\nDisallow: /r/\nDisallow: /api/\n${origin?`Sitemap: ${origin}/sitemap.xml\n`:''}`
          :`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/partners</loc></url><url><loc>${origin}/client</loc></url></urlset>\n`;
        res.writeHead(200,{'Content-Type':url.pathname==='/robots.txt'?'text/plain; charset=utf-8':'application/xml; charset=utf-8','Cache-Control':'no-cache'});
        return res.end(text);
      }
      if(req.method==='GET' && files[url.pathname]) {
        const file=files[url.pathname];
        let contents=await readFile(new URL('../public/'+file,import.meta.url));
        if(file==='home.html') {
          // Social/SEO tags need absolute URLs: fill them from PUBLIC_ORIGIN when set, otherwise
          // fall back to root-relative URLs and omit the canonical link (never a guessed domain).
          const origin=publicOriginOf(env);
          contents=Buffer.from(contents.toString('utf8').replaceAll('{{ORIGIN}}',origin).replace('{{CANONICAL}}',origin?`<link rel="canonical" href="${origin}/">`:''));
        }
        const type=file.endsWith('.svg')?'image/svg+xml':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.woff2')?'font/woff2':file.endsWith('.webmanifest')?'application/manifest+json':file.endsWith('.png')?'image/png':file.endsWith('.json')?'application/json; charset=utf-8':'text/html; charset=utf-8';
        // `img-src` explicitly allows `data:` alongside `'self'` — a real, existing feature
        // (a content item's optional `assetUrl`, src/domain.js) can be a self-contained inline
        // image with no outbound network request at all; every other directive is untouched
        // (script-src/style-src stay 'self'-only, so this never opens any script/style vector —
        // data: URIs are permitted for images only).
        const headers={'Content-Type':type,'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
        // Fonts/icons are truly immutable (their filename never changes) so a long cache is
        // safe; every other static asset (js/css/json/html) has no content hash in its URL, so
        // without an explicit no-cache a browser's own heuristic caching can keep serving a
        // pre-deploy copy of app.js/i18n.js/navigation.json for a while after a real deploy —
        // exactly the "shows raw i18n keys, blank page" symptom seen live after shipping the
        // WhatsApp Hub page. no-cache still lets the browser keep a copy, it just always
        // revalidates with the server first, so every deploy is visible on next load.
        headers['Cache-Control']=(file.endsWith('.woff2')||file.endsWith('.png'))?'public, max-age=31536000, immutable':'no-cache';
        res.writeHead(200,headers);
        return res.end(contents);
      }
      send(404,{error:'Not found'});
    } catch(error) {send(error instanceof ConnectorError?502:error.status||400,{error:error.message,...(error.details?{details:error.details}:{})});}
  });
  return {server,store,scheduler};
}
// PUBLIC_ORIGIN normalised to a bare origin (no path/trailing slash), or '' when unset/invalid.
function publicOriginOf(env) {
  try{return env?.PUBLIC_ORIGIN?new URL(env.PUBLIC_ORIGIN).origin:'';}catch{return '';}
}
export async function startServer() {
  console.log('HyperCool: initializing application');
  try{loadEnvFile(fileURLToPath(new URL('../.env',import.meta.url)));}catch(error){if(error.code!=='ENOENT')throw error;}
  validateEnv(process.env);
  const {server,scheduler}=await createApp();
  const port=Number(process.env.PORT||3000);
  server.on('error',error=>{console.error('Server startup failed:',error);process.exitCode=1;});
  server.listen(port,process.env.HOST||(process.env.PUBLIC_ORIGIN?'0.0.0.0':'127.0.0.1'),()=>{
    console.log(`HyperCool: http://localhost:${port}`);
    scheduler.start();
    console.log('Agent scheduler running — daily brief 08:00, weekly report Sunday, follow-up gap sweep every tick (Asia/Riyadh).');
  });
}
