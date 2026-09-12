// Universal Integration Platform (Phase 6A) — the Connector Registry: assembles every real
// {manifest, adapter} pair, validates each adapter against its own manifest at module-load
// time (fail fast on a real mismatch, never at first real request), and exposes simple,
// read-only lookups. This is ADDITIVE — nothing here is wired into src/application.js's live
// HTTP routes yet (that is Phase 6B/6D's job); today it exists to prove the SDK itself is
// sound and that Salla/Anthropic/OpenAI can be represented as real Connectors without
// rewriting their existing implementations.
import {validateAdapter} from './core/adapter.js';
import {sallaManifest} from './salla/manifest.js';
import {sallaAdapter} from './salla/adapter.js';
import {anthropicManifest} from './anthropic/manifest.js';
import {anthropicAdapter} from './anthropic/adapter.js';
import {openaiManifest} from './openai/manifest.js';
import {openaiAdapter} from './openai/adapter.js';

const ENTRIES=[
 {manifest:sallaManifest,adapter:sallaAdapter},
 {manifest:anthropicManifest,adapter:anthropicAdapter},
 {manifest:openaiManifest,adapter:openaiAdapter}
];
for(const {manifest,adapter} of ENTRIES)validateAdapter(adapter,manifest);

const BY_SLUG=new Map(ENTRIES.map(entry=>[entry.manifest.slug,entry]));

export function listConnectorManifests() {
 return ENTRIES.map(e=>e.manifest);
}
export function getConnector(slug) {
 return BY_SLUG.get(slug)||null;
}
export function getConnectorManifest(slug) {
 return BY_SLUG.get(slug)?.manifest||null;
}
export function getConnectorAdapter(slug) {
 return BY_SLUG.get(slug)?.adapter||null;
}
