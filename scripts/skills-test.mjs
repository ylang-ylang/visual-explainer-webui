#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../remote-app/catalog.mjs';
import { createCommentsStore } from '../remote-app/comments.mjs';
import { createSkills, parseTemplateFrontmatter, sha256Hex, validateExplainerId, validateTemplateId } from '../remote-app/skills.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILTIN_DIR = join(REPO_ROOT, 'remote-app', 'builtin-skills');

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 've-skills-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sampleUpstreamDocs(overrides = {}) {
  return {
    'SKILL.md': [
      '# Visual Explainer Skill',
      'Line 2: core rule alpha',
      'Line 3: core rule beta',
      'Line 4: core rule gamma',
      'Line 5: footer',
      '',
    ].join('\n'),
    'references/kit.md': [
      '# Kit Reference',
      'Section A: top intro',
      'Section B: middle paragraph 1',
      'Section C: middle paragraph 2',
      'Section D: middle paragraph 3',
      'Section E: bottom details',
      '',
    ].join('\n'),
    'references/motion.md': [
      '# Motion Reference',
      'Original motion rule v1',
      '',
    ].join('\n'),
    'commands/diff-review.md': [
      '# Diff Review Command',
      'Original diff review template',
      '',
    ].join('\n'),
    ...overrides,
  };
}

test('skills.mjs initializes upstream + active git branches, defaults editEnabled=false, enforces private state, and manages ve_sk_ keys', () => withTempDir(async dir => {
  const docs = sampleUpstreamDocs();
  const skills = await createSkills(dir, {
    upstreamDocs: docs,
    upstreamMeta: { version: '0.6.1', revision: '147ecdc8c5a096f1ddd6319db8be9ee7f6ee9821' },
    builtinDir: BUILTIN_DIR,
    builtinExplainers: [],
  });

  assert.equal(skills.isEditEnabled(), false);
  assert.equal(skills.initialSync.action, 'initialized');

  const statePath = join(dir, '.skills-state.json');
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);

  // Includes all upstream docs + built-in webui/bootstrap-prompt.md + templates/default.md
  const listedDocs = skills.listDocs();
  assert.equal(listedDocs.length, 6);
  assert.deepEqual(listedDocs.map(d => d.id), [
    'SKILL.md',
    'commands/diff-review.md',
    'references/kit.md',
    'references/motion.md',
    'templates/default.md',
    'webui/bootstrap-prompt.md',
  ]);
  for (const d of listedDocs) {
    assert.equal(d.status, 'upstream');
    assert.equal(d.hasConflict, false);
    assert.equal(d.sha256, d.upstreamSha256);
    assert.equal(d.explainerId, null);
    assert.equal(d.explainerSynced, false);
  }
  assert.equal(listedDocs.find(d => d.id === 'SKILL.md').category, 'core');
  assert.equal(listedDocs.find(d => d.id === 'references/kit.md').category, 'reference');
  assert.equal(listedDocs.find(d => d.id === 'commands/diff-review.md').category, 'command');
  assert.equal(listedDocs.find(d => d.id === 'templates/default.md').category, 'template');
  assert.equal(listedDocs.find(d => d.id === 'webui/bootstrap-prompt.md').category, 'webui');

  assert.equal(skills.defaultTemplate(), 'default');
  const listedTemplates = skills.listTemplates();
  assert.equal(listedTemplates.length, 1);
  assert.equal(listedTemplates[0].id, 'default');
  assert.equal(listedTemplates[0].docId, 'templates/default.md');
  assert.equal(listedTemplates[0].isDefault, true);
  assert.equal(listedTemplates[0].builtIn, true);
  assert.equal(listedTemplates[0].status, 'upstream');
  assert.equal(listedTemplates[0].title, 'Default Wiki & Component Diff');
  assert.ok(listedTemplates[0].whenToUse.length > 10);

  // Strict doc ID, template ID & explainer ID validation rejects path traversal / invalid names
  for (const badDoc of ['../SKILL.md', 'kit/kit.css', 'references/UPPER.md', '/SKILL.md', 'evil.md', 'references/../SKILL.md', 'templates/UPPER.md', 'templates/html.md']) {
    assert.throws(() => skills.validateDocId(badDoc), err => err instanceof ApiError && err.status === 400);
  }
  for (const badTpl of ['', '../evil', 'UPPER', '-leading', 'a/b', 'html', 'source', 'thumb']) {
    assert.throws(() => validateTemplateId(badTpl), err => err instanceof ApiError && err.status === 400);
  }
  assert.throws(() => skills.validateDocId('references/does-not-exist.md'), err => err instanceof ApiError && err.status === 404);
  for (const badId of ['', '../evil', 'a//b', 'foo/', '/bar', 'commands/html', 'a/source', 'a/thumb']) {
    assert.throws(() => validateExplainerId(badId), err => err instanceof ApiError && err.status === 400);
  }
  for (const goodId of ['overview', 'SKILL', 'bootstrap-prompt', 'style-guide', 'commands/diff-review']) {
    assert.equal(validateExplainerId(goodId), goodId);
  }

  // Edit lock toggle & ve_sk_ key lifecycle
  await skills.setEditEnabled(true);
  assert.equal(skills.isEditEnabled(), true);
  const created = await skills.createKey({ name: 'Docs Agent', createdBy: 'Owner' });
  assert.match(created.key.id, /^sk_[0-9a-f]{16}$/);
  assert.match(created.secret, /^ve_sk_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.key.prefix, created.secret.slice(0, 12));
  assert.equal('hash' in created.key, false);

  const rawState = await readFile(statePath, 'utf8');
  assert.equal(rawState.includes(created.secret), false, 'Plaintext secret must never be persisted');

  const auth = skills.authenticateKey(created.secret);
  assert.deepEqual(auth, { role: 'skill-editor', keyId: created.key.id, name: 'Docs Agent', bearer: true });
  assert.equal(skills.authenticateKey('ve_sk_' + 'A'.repeat(43)), null);
  assert.equal(skills.authenticateKey('ve_' + 'A'.repeat(43)), null);

  // Reload persists editEnabled + keys + tightens permissions
  await chmod(statePath, 0o644);
  const reloaded = await createSkills(dir, {
    upstreamDocs: docs,
    upstreamMeta: { version: '0.6.1', revision: '147ecdc8c5a096f1ddd6319db8be9ee7f6ee9821' },
    builtinDir: BUILTIN_DIR,
    builtinExplainers: [],
  });
  assert.equal(reloaded.initialSync.action, 'noop');
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.equal(reloaded.isEditEnabled(), true);
  assert.ok(reloaded.authenticateKey(created.secret));

  await reloaded.revokeKey(created.key.id);
  assert.equal(reloaded.authenticateKey(created.secret), null);
  assert.equal(reloaded.listKeys().length, 0);

  // Reject symlinked state file
  const symDir = await mkdtemp(join(tmpdir(), 've-skills-sym-'));
  try {
    await symlink(statePath, join(symDir, '.skills-state.json'));
    await assert.rejects(
      () => createSkills(symDir, { upstreamDocs: docs, builtinDir: BUILTIN_DIR, builtinExplainers: [] }),
      /regular private file/,
    );
  } finally {
    await rm(symDir, { recursive: true, force: true });
  }
}));

test('skills.mjs enforces strict SHA-256 hash binding, tracks affectedExplainers, supports lockstep rollback & doc reset', () => withTempDir(async dir => {
  const docs = sampleUpstreamDocs();
  const initialSkillSha = sha256Hex(docs['SKILL.md']);
  const skills = await createSkills(dir, {
    upstreamDocs: docs,
    upstreamMeta: { version: '0.6.1', revision: 'rev1' },
    builtinDir: BUILTIN_DIR,
    builtinExplainers: [
      {
        id: 'SKILL',
        title: 'Core Skill',
        summary: 'Built-in core explainer',
        layer: 1,
        parentId: 'overview',
        covers: ['SKILL.md'],
        skillHash: initialSkillSha,
        html: '<html><head><title>Core Skill v1</title></head><body>Upstream Core v1</body></html>',
        sourceHtml: '<html><body>Upstream Core v1 src</body></html>',
      },
    ],
  });

  // Built-in explainer starts synced
  assert.equal(skills.getExplainer('SKILL').synced, true);
  assert.equal(skills.listDocs().find(d => d.id === 'SKILL.md').explainerId, 'SKILL');
  assert.equal(skills.listDocs().find(d => d.id === 'SKILL.md').explainerSynced, true);

  // Update SKILL.md -> v2 -> built-in SKILL explainer becomes out-of-sync
  const editedSkill = docs['SKILL.md'] + 'Line 6: custom team rule\n';
  const upd = await skills.updateDoc('SKILL.md', editedSkill, { note: 'Add team rule', actor: 'Alice' });
  assert.equal(upd.version.label, 'v2');
  assert.equal(upd.doc.status, 'overridden');
  assert.equal(upd.doc.explainerSynced, false);
  assert.equal(upd.affectedExplainers.length, 1);
  assert.equal(upd.affectedExplainers[0].id, 'SKILL');
  assert.equal(upd.affectedExplainers[0].synced, false);

  // Unified diff vs upstream shows our added line
  const diff = await skills.diffDoc('SKILL.md');
  assert.ok(diff.includes('+Line 6: custom team rule'));

  // Updating explainer with stale hash throws ApiError 409 with structured details
  await assert.rejects(
    () => skills.updateExplainer('SKILL', {
      html: '<html><body>Updated v2</body></html>',
      sourceHtml: '<html><body>Updated v2 src</body></html>',
      covers: ['SKILL.md'],
      skillHash: initialSkillSha,
    }),
    err => err instanceof ApiError &&
      err.status === 409 &&
      err.details?.expectedSkillHash === sha256Hex(editedSkill) &&
      err.details?.providedSkillHash === initialSkillSha,
  );

  // Updating explainer with matching hash succeeds -> v3, synced=true
  const expUpd = await skills.updateExplainer('SKILL', {
    html: '<html><head><title>Core Skill v2</title></head><body>Custom Core v2</body></html>',
    sourceHtml: '<html><body>Custom Core v2 src</body></html>',
    title: 'Core Skill v2',
    covers: ['SKILL.md'],
    skillHash: sha256Hex(editedSkill),
    note: 'Sync explainer to v2',
    actor: 'Alice',
  });
  assert.equal(expUpd.version.label, 'v3');
  assert.equal(expUpd.synced, true);
  assert.equal(skills.listDocs().find(d => d.id === 'SKILL.md').explainerSynced, true);

  // Wildcard overview explainer hashes all managed docs
  const overviewHash = skills.expectedSkillHash(['*']);
  await skills.updateExplainer('overview', {
    html: '<html><body>Overview v3</body></html>',
    sourceHtml: '<html><body>Overview v3 src</body></html>',
    covers: ['*'],
    skillHash: overviewHash,
    layer: 0,
  });
  assert.equal(skills.getExplainer('overview').synced, true);
  assert.equal(skills.versions().length, 4);

  // Further edit SKILL.md -> v5 (now both SKILL and overview are out of sync)
  const editedSkill2 = editedSkill + 'Line 7: temporary experiment\n';
  const upd2 = await skills.updateDoc('SKILL.md', editedSkill2, { note: 'Experiment' });
  assert.equal(upd2.version.label, 'v5');
  assert.deepEqual(upd2.affectedExplainers.map(e => e.id).sort(), ['SKILL', 'overview']);

  // Lockstep rollback to v3 restores BOTH SKILL.md (v2 content) AND bound SKILL explainer HTML as forward commit v6!
  const rb = await skills.rollback('v3', { note: 'Revert experiment' });
  assert.equal(rb.version.label, 'v6');
  assert.equal(rb.rolledBackTo.label, 'v3');
  assert.equal(skills.getEffectiveDoc('SKILL.md'), editedSkill);
  assert.equal(skills.getExplainerHtml('SKILL'), '<html><head><title>Core Skill v2</title></head><body>Custom Core v2</body></html>');
  assert.equal(skills.getExplainer('SKILL').synced, true);

  // Reset SKILL.md restores BOTH upstream SKILL.md AND matching built-in upstream SKILL explainer!
  const rst = await skills.resetDoc('SKILL.md', { note: 'Back to upstream' });
  assert.equal(rst.doc.status, 'upstream');
  assert.equal(rst.resetExplainerId, 'SKILL');
  assert.equal(skills.getEffectiveDoc('SKILL.md'), docs['SKILL.md']);
  assert.equal(skills.getExplainerHtml('SKILL'), '<html><head><title>Core Skill v1</title></head><body>Upstream Core v1</body></html>');
  assert.equal(skills.getExplainer('SKILL').synced, true);

  // Version history + version diff
  const skillVersions = skills.versions('SKILL.md');
  assert.ok(skillVersions.length >= 4);
  const v2Diff = await skills.versionDiff('v2');
  assert.equal(v2Diff.label, 'v2');
  assert.ok(v2Diff.diff.includes('+Line 6: custom team rule'));
}));

test('skills.mjs performs real 3-way merge on upstream upgrades (fast-forward, clean merge, conflict preserving active, and conflict resolution)', () => withTempDir(async dir => {
  const v1Docs = sampleUpstreamDocs();
  const kitHashV1 = sha256Hex(v1Docs['references/kit.md']);
  const motionHashV1 = sha256Hex(v1Docs['references/motion.md']);

  const skills = await createSkills(dir, {
    upstreamDocs: v1Docs,
    upstreamMeta: { version: '0.6.1', revision: 'rev-v1' },
    builtinDir: BUILTIN_DIR,
    builtinExplainers: [
      {
        id: 'kit',
        title: 'Kit v1',
        covers: ['references/kit.md'],
        skillHash: kitHashV1,
        html: '<html><body>Kit explainer v1</body></html>',
      },
      {
        id: 'motion',
        title: 'Motion v1',
        covers: ['references/motion.md'],
        skillHash: motionHashV1,
        html: '<html><body>Motion explainer v1</body></html>',
      },
    ],
  });

  // 1. Customize references/kit.md at the TOP (non-overlapping with upcoming upstream edit at BOTTOM)
  const customKit = v1Docs['references/kit.md'].replace('Section A: top intro', 'Section A: TEAM CUSTOM INTRO');
  await skills.updateDoc('references/kit.md', customKit, { note: 'Customize kit top' });
  // Also customize kit explainer so active owns it
  await skills.updateExplainer('kit', {
    html: '<html><body>Custom Kit explainer</body></html>',
    sourceHtml: '<html><body>Custom Kit explainer src</body></html>',
    covers: ['references/kit.md'],
    skillHash: sha256Hex(customKit),
  });
  assert.equal(skills.getExplainer('kit').synced, true);

  // 2. Customize SKILL.md on Line 3 (OVERLAPPING with upcoming upstream edit on Line 3 -> conflict!)
  const customSkill = v1Docs['SKILL.md'].replace('Line 3: core rule beta', 'Line 3: TEAM OVERRIDE BETA');
  await skills.updateDoc('SKILL.md', customSkill, { note: 'Override rule beta' });

  // 3. Leave references/motion.md untouched (clean fast-forward!)

  // Simulate upstream upgrade to v0.7.0!
  const v2Docs = {
    ...v1Docs,
    'references/motion.md': '# Motion Reference\nUpstream motion rule v2\n',
    'references/kit.md': v1Docs['references/kit.md'].replace('Section E: bottom details', 'Section E: UPSTREAM V2 BOTTOM'),
    'SKILL.md': v1Docs['SKILL.md'].replace('Line 3: core rule beta', 'Line 3: UPSTREAM V2 BETA'),
  };
  const syncRes = await skills.syncUpstream({
    upstreamDocs: v2Docs,
    upstreamMeta: { version: '0.7.0', revision: 'rev-v2' },
    builtinDir: BUILTIN_DIR,
    builtinExplainers: [
      {
        id: 'kit',
        title: 'Kit v2',
        covers: ['references/kit.md'],
        skillHash: sha256Hex(v2Docs['references/kit.md']),
        html: '<html><body>Upstream Kit explainer v2</body></html>',
      },
      {
        id: 'motion',
        title: 'Motion v2',
        covers: ['references/motion.md'],
        skillHash: sha256Hex(v2Docs['references/motion.md']),
        html: '<html><body>Upstream Motion explainer v2</body></html>',
      },
    ],
  });

  assert.equal(syncRes.action, 'merged');
  assert.ok(syncRes.fastForwardedDocs.includes('references/motion.md'));
  assert.deepEqual(syncRes.mergedDocs, ['references/kit.md']);
  assert.deepEqual(syncRes.conflictedDocs, ['SKILL.md']);

  // A. Unmodified file fast-forwarded cleanly AND its untouched upstream explainer updated & stays synced!
  assert.equal(skills.getEffectiveDoc('references/motion.md'), v2Docs['references/motion.md']);
  assert.equal(skills.getExplainerHtml('motion'), '<html><body>Upstream Motion explainer v2</body></html>');
  assert.equal(skills.getExplainer('motion').synced, true);

  // B. Non-overlapping modified file cleanly 3-way merged BOTH edits, kept customized explainer, and flagged explainerSynced=false!
  const mergedKit = skills.getEffectiveDoc('references/kit.md');
  assert.ok(mergedKit.includes('Section A: TEAM CUSTOM INTRO'), 'Merged doc must preserve local custom edit');
  assert.ok(mergedKit.includes('Section E: UPSTREAM V2 BOTTOM'), 'Merged doc must include non-overlapping upstream edit');
  assert.ok(!mergedKit.includes('<<<<<<<'), 'Clean 3-way merge must not contain conflict markers');
  assert.equal(skills.getExplainerHtml('kit'), '<html><body>Custom Kit explainer</body></html>');
  assert.equal(skills.getExplainer('kit').synced, false);
  assert.equal(skills.listDocs().find(d => d.id === 'references/kit.md').explainerSynced, false);

  // C. Conflicting file kept last known good active content untouched (zero production outage!) and recorded full conflict!
  assert.equal(skills.getEffectiveDoc('SKILL.md'), customSkill, 'Conflicting doc must keep last known good active content');
  const skillDoc = await skills.getDoc('SKILL.md');
  assert.equal(skillDoc.status, 'conflict');
  assert.equal(skillDoc.hasConflict, true);
  assert.equal(skillDoc.conflict.base, v1Docs['SKILL.md']);
  assert.equal(skillDoc.conflict.ours, customSkill);
  assert.equal(skillDoc.conflict.theirs, v2Docs['SKILL.md']);
  assert.ok(skillDoc.conflict.mergedMarkers.includes('<<<<<<< active'));
  assert.ok(skillDoc.conflict.mergedMarkers.includes('>>>>>>> upstream'));
  assert.equal(skillDoc.conflict.upstreamVersion, '0.7.0');

  // Resolving via updateDoc clears conflict and persists across reload!
  const resolvedSkill = v1Docs['SKILL.md'].replace('Line 3: core rule beta', 'Line 3: COMBINED TEAM + UPSTREAM V2 BETA');
  await skills.updateDoc('SKILL.md', resolvedSkill, { note: 'Resolve v0.7.0 conflict' });
  const afterResolve = await skills.getDoc('SKILL.md');
  assert.equal(afterResolve.status, 'overridden');
  assert.equal(afterResolve.hasConflict, false);
  assert.equal(afterResolve.conflict, null);

  const reloaded = await createSkills(dir, {
    upstreamDocs: v2Docs,
    upstreamMeta: { version: '0.7.0', revision: 'rev-v2' },
    builtinDir: BUILTIN_DIR,
    builtinExplainers: [
      {
        id: 'kit',
        title: 'Kit v2',
        covers: ['references/kit.md'],
        skillHash: sha256Hex(v2Docs['references/kit.md']),
        html: '<html><body>Upstream Kit explainer v2</body></html>',
      },
      {
        id: 'motion',
        title: 'Motion v2',
        covers: ['references/motion.md'],
        skillHash: sha256Hex(v2Docs['references/motion.md']),
        html: '<html><body>Upstream Motion explainer v2</body></html>',
      },
    ],
  });
  assert.equal(reloaded.getEffectiveDoc('SKILL.md'), resolvedSkill);
  assert.equal(reloaded.getEffectiveDoc('references/kit.md'), mergedKit);
  assert.deepEqual(reloaded.conflicts(), {});
}));

test('dedicated skill comments store (.skills-comments.json) stays isolated from page comments and validates explainer IDs', () => withTempDir(async dir => {
  const pageComments = await createCommentsStore(dir);
  const skillComments = await createCommentsStore(dir, {
    storeFile: '.skills-comments.json',
    validateKey: validateExplainerId,
  });

  await pageComments.create({
    filename: 'diagram.html',
    author: { role: 'admin', name: 'Owner' },
    body: 'Diagram comment',
  });
  const s1 = await skillComments.create({
    filename: 'commands/diff-review',
    author: { role: 'admin', name: 'Owner' },
    body: 'Tighten diff-review checklist',
  });
  assert.equal(s1.thread.id, 'c_1');
  assert.equal(s1.thread.filename, 'commands/diff-review');
  assert.equal(pageComments.list('diagram.html').threads.length, 1);
  assert.equal(skillComments.list(null).threads.length, 1);
  assert.equal(skillComments.list('commands/diff-review').threads.length, 1);
  assert.equal(skillComments.list('SKILL').threads.length, 0);

  // Reply, edit, resolve, reopen, remove by ID without explicit filename
  const rep = await skillComments.reply({ threadId: s1.thread.id, author: { role: 'agent', name: 'Skill Editor' }, body: 'Updated' });
  assert.equal(rep.thread.replies.length, 1);
  const res = await skillComments.resolve({ threadId: s1.thread.id, actor: { role: 'agent', name: 'Skill Editor' }, note: 'Done' });
  assert.equal(res.thread.status, 'resolved');
  const reo = await skillComments.reopen({ threadId: s1.thread.id });
  assert.equal(reo.thread.status, 'open');
  const ed = await skillComments.edit({ commentId: s1.thread.id, body: 'Edited skill comment' });
  assert.equal(ed.thread.body, 'Edited skill comment');
  const rem = await skillComments.remove({ commentId: s1.thread.id });
  assert.equal(rem.deleted, true);
  assert.equal(skillComments.list(null).threads.length, 0);
  // Page comment remains untouched
  assert.equal(pageComments.list('diagram.html').threads.length, 1);
}));

test('skills.mjs manages built-in & custom templates, frontmatter fallback, default selection, upstream sync preservation, and rollback', () => withTempDir(async dir => {
  // Frontmatter parser handles explicit YAML frontmatter and graceful fallback
  const parsedFm = parseTemplateFrontmatter('rfc', '---\ntitle: "RFC Blueprint"\nwhenToUse: Use for RFC design proposals.\n---\n# Body\nDetails\n');
  assert.deepEqual(parsedFm, { title: 'RFC Blueprint', whenToUse: 'Use for RFC design proposals.' });
  const parsedFallback = parseTemplateFrontmatter('plain-guide', '# Heading Only\n\nFirst non-heading summary line.\nSecond line.\n');
  assert.deepEqual(parsedFallback, { title: 'plain-guide', whenToUse: 'First non-heading summary line.' });

  const docs = sampleUpstreamDocs();
  const skills = await createSkills(dir, {
    upstreamDocs: docs,
    upstreamMeta: { version: '0.6.1', revision: 'rev1' },
    builtinDir: BUILTIN_DIR,
    builtinExplainers: [],
  });

  const beforeWildcardHash = skills.expectedSkillHash(['*']);
  const postmortemMd = [
    '---',
    'title: Incident Postmortem',
    'whenToUse: Use for outage timelines, root-cause chains, and remediation follow-ups.',
    '---',
    '',
    '# Incident Postmortem Template',
    '',
    '- L0 timeline + impact map',
    '- L1 component failure drill-down',
    '',
  ].join('\n');

  // Create custom template -> v2
  const created = await skills.createTemplate('postmortem', postmortemMd, { note: 'Add postmortem template', actor: 'Alice' });
  assert.equal(created.version.label, 'v2');
  assert.equal(created.template.id, 'postmortem');
  assert.equal(created.template.docId, 'templates/postmortem.md');
  assert.equal(created.template.title, 'Incident Postmortem');
  assert.equal(created.template.whenToUse, 'Use for outage timelines, root-cause chains, and remediation follow-ups.');
  assert.equal(created.template.builtIn, false);
  assert.equal(created.template.isDefault, false);
  assert.equal(created.template.status, 'custom');
  assert.equal(created.doc.status, 'custom');
  assert.equal(created.doc.upstreamSha256, null);
  assert.equal(skills.hasDoc('templates/postmortem.md'), true);
  assert.equal(skills.expectedSkillHash(['templates/postmortem.md']), sha256Hex(postmortemMd));
  assert.notEqual(skills.expectedSkillHash(['*']), beforeWildcardHash);

  // Duplicate template rejected with 409; resetting custom template rejected with 409
  await assert.rejects(() => skills.createTemplate('postmortem', '# Dup\n'), err => err instanceof ApiError && err.status === 409);
  await assert.rejects(() => skills.resetDoc('templates/postmortem.md'), err => err instanceof ApiError && err.status === 409);

  // Built-in template cannot be deleted
  await assert.rejects(
    () => skills.deleteTemplate('default'),
    err => err instanceof ApiError && err.status === 409 && /built-in/i.test(err.message),
  );

  // Bind dedicated explainer to custom template
  const tplExp = await skills.updateExplainer('templates/postmortem', {
    html: '<html><head><title>Postmortem Guide</title></head><body>Postmortem explainer</body></html>',
    sourceHtml: '<html><body>Postmortem src</body></html>',
    skillHash: sha256Hex(postmortemMd),
    note: 'Bind postmortem explainer',
  });
  assert.equal(tplExp.synced, true);
  assert.equal(tplExp.version.label, 'v3');
  assert.deepEqual(tplExp.explainer.covers, ['templates/postmortem.md']);

  // Set default template -> persists across reload & sorts first
  const switched = await skills.setDefaultTemplate('postmortem');
  assert.equal(switched.defaultTemplate, 'postmortem');
  assert.equal(switched.templates[0].id, 'postmortem');
  assert.equal(switched.templates[0].isDefault, true);
  assert.equal(switched.templates[1].id, 'default');
  assert.equal(switched.templates[1].isDefault, false);

  // Cannot delete active default template (409)
  await assert.rejects(
    () => skills.deleteTemplate('postmortem'),
    err => err instanceof ApiError && err.status === 409 && /default/i.test(err.message),
  );

  // Reload + upstream upgrade preserves custom template & defaultTemplate selection!
  const reloaded = await createSkills(dir, {
    upstreamDocs: { ...docs, 'references/motion.md': '# Motion v2\nUpdated motion\n' },
    upstreamMeta: { version: '0.7.0', revision: 'rev2' },
    builtinDir: BUILTIN_DIR,
    builtinExplainers: [],
  });
  assert.equal(reloaded.defaultTemplate(), 'postmortem');
  assert.equal(reloaded.hasDoc('templates/postmortem.md'), true);
  assert.equal(reloaded.getEffectiveDoc('templates/postmortem.md'), postmortemMd);
  assert.equal(reloaded.getExplainer('templates/postmortem').synced, true);

  // Switch default back to 'default' and delete custom template -> removes doc & dedicated explainer
  await reloaded.setDefaultTemplate('default');
  const deleted = await reloaded.deleteTemplate('postmortem', { note: 'Retire postmortem' });
  assert.equal(deleted.deleted, true);
  assert.deepEqual(deleted.deletedExplainerIds, ['templates/postmortem']);
  assert.equal(reloaded.hasDoc('templates/postmortem.md'), false);
  assert.throws(() => reloaded.getExplainer('templates/postmortem'), err => err instanceof ApiError && err.status === 404);

  // Rollback to v3 restores custom template AND its dedicated explainer!
  const rbRestore = await reloaded.rollback('v3', { note: 'Restore postmortem template' });
  assert.equal(reloaded.hasDoc('templates/postmortem.md'), true);
  assert.equal(reloaded.getEffectiveDoc('templates/postmortem.md'), postmortemMd);
  assert.equal(reloaded.getExplainer('templates/postmortem').synced, true);
  assert.ok(rbRestore.templates.some(t => t.id === 'postmortem'));

  // Set default to custom template, then rollback to v1 (before postmortem existed) -> defaultTemplate safely resets to 'default'!
  await reloaded.setDefaultTemplate('postmortem');
  assert.equal(reloaded.defaultTemplate(), 'postmortem');
  const rbV1 = await reloaded.rollback('v1', { note: 'Reset to v1 before custom template' });
  assert.equal(reloaded.hasDoc('templates/postmortem.md'), false);
  assert.equal(reloaded.defaultTemplate(), 'default');
  assert.equal(rbV1.defaultTemplate, 'default');
  assert.deepEqual(rbV1.templates.map(t => t.id), ['default']);
}));

// ---- Full HTTP + MCP + Upstream Renderer Integration Suite ----

function dockerImageAvailable(image) {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitHealthy(baseUrl) {
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(new URL('/health', baseUrl), { signal: AbortSignal.timeout(1000) });
      if (res.status === 200 && await res.text() === 'ok') return;
    } catch {}
    await delay(500);
  }
  throw new Error('Disposable skills test container did not become healthy');
}

const TEST_IMAGE = process.env.VE_SKILLS_IMAGE || 'visual-explainer-webui:local-debug';
const HAS_DOCKER_IMAGE = dockerImageAvailable(TEST_IMAGE);

test('HTTP/MCP/Renderer E2E: enumeration, permission isolation, lock switch, live override, hash binding, rollback/reset, comments & SSE dispatch', {
  skip: !HAS_DOCKER_IMAGE ? `Docker image ${TEST_IMAGE} not available` : false,
  timeout: 180000,
}, async () => {
  const fixture = await mkdtemp(join(tmpdir(), 've-skills-http-'));
  const dataDir = join(fixture, 'data');
  const tokenPath = join(fixture, 'token');
  const adminToken = randomBytes(32).toString('hex');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const containerName = `ve-skills-test-${randomBytes(5).toString('hex')}`;

  await writeFile(tokenPath, adminToken, { mode: 0o444 });
  execFileSync('mkdir', ['-p', dataDir]);
  await chmod(fixture, 0o777);
  await chmod(dataDir, 0o777);

  const bindFiles = [
    'server.mjs', 'catalog.mjs', 'comments.mjs', 'events.mjs',
    'accounts.mjs', 'history.mjs', 'skills.mjs', 'tokens.mjs', 'index.html',
  ];
  const mountArgs = [];
  for (const file of bindFiles) {
    mountArgs.push('--mount', `type=bind,src=${join(REPO_ROOT, 'remote-app', file)},dst=/opt/bridge/${file},readonly`);
  }
  mountArgs.push('--mount', `type=bind,src=${BUILTIN_DIR},dst=/opt/bridge/builtin-skills,readonly`);
  mountArgs.push('--mount', `type=bind,src=${join(REPO_ROOT, 'remote-app', 'static')},dst=/opt/bridge/static,readonly`);

  let failed = false;
  try {
    execFileSync('docker', [
      'run', '--detach', '--name', containerName,
      '--publish', `127.0.0.1:${port}:${port}`,
      '--env', `PUBLIC_URL=${baseUrl}`,
      '--env', `PORT=${port}`,
      '--env', 'VISUAL_EXPLAINER_OUTPUT_DIR=/data',
      '--env', 'TOKEN_FILE=/run/secrets/api_token',
      '--mount', `type=bind,src=${dataDir},dst=/data`,
      '--mount', `type=bind,src=${tokenPath},dst=/run/secrets/api_token,readonly`,
      ...mountArgs,
      TEST_IMAGE,
    ], { stdio: 'ignore' });

    await waitHealthy(baseUrl);

    async function req(path, { method = 'GET', auth = adminToken, body, raw, headers = {}, status } = {}) {
      const res = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(120000),
      });
      if (status !== undefined) {
        const clone = res.clone();
        const detail = res.status !== status ? await clone.text() : '';
        assert.equal(res.status, status, `${method} ${path}: expected ${status}, got ${res.status} (${detail})`);
      }
      return res;
    }

    // 1. Complete enumeration: 21 upstream Markdown docs + webui/bootstrap-prompt.md + templates/default.md = 23 docs (no kit/kit.css)
    const overview0 = await (await req('/api/skills', { status: 200 })).json();
    assert.equal(overview0.editEnabled, false, 'editEnabled must default to false on fresh init');
    assert.equal(overview0.docs.length, 23, 'Expected 21 upstream docs + webui/bootstrap-prompt.md + templates/default.md');
    assert.ok(overview0.docs.some(d => d.id === 'SKILL.md' && d.category === 'core'));
    assert.ok(overview0.docs.some(d => d.id === 'webui/bootstrap-prompt.md' && d.category === 'webui'));
    assert.ok(overview0.docs.some(d => d.id === 'templates/default.md' && d.category === 'template'));
    assert.equal(overview0.docs.filter(d => d.category === 'reference').length, 10);
    assert.equal(overview0.docs.filter(d => d.category === 'command').length, 10);
    assert.equal(overview0.docs.filter(d => d.category === 'template').length, 1);
    assert.equal(overview0.docs.some(d => d.id.includes('kit.css')), false);
    assert.equal(overview0.defaultTemplate, 'default');
    assert.equal(overview0.templates.length, 1);
    assert.equal(overview0.templates[0].id, 'default');
    assert.equal(overview0.templates[0].isDefault, true);
    assert.equal(overview0.templates[0].builtIn, true);
    assert.equal(overview0.versionCount, 1);
    assert.equal(overview0.latestVersion.label, 'v1');
    assert.equal(overview0.keysCount, 0);
    assert.ok(overview0.explainers.length >= 8, 'Expected built-in progressive explainers loaded');
    for (const upExpId of ['SKILL', 'style-guide', 'kit', 'diagrams', 'motion', 'commands-and-extras']) {
      const exp = overview0.explainers.find(e => e.id === upExpId);
      assert.ok(exp && exp.synced === true, `Built-in upstream explainer ${upExpId} must start synced`);
    }
    assert.ok(overview0.explainers.some(e => e.id === 'overview'));
    assert.ok(overview0.explainers.some(e => e.id === 'bootstrap-prompt'));
    assert.equal(Object.keys(overview0.conflicts || {}).length, 0, 'Expected 0 conflicts on fresh init');

    // Bootstrap prompt & read-only templates discovery endpoints work
    const bp0 = await (await req('/api/visual-explainer/bootstrap-prompt', { status: 200 })).json();
    assert.equal(bp0.id, 'webui/bootstrap-prompt.md');
    assert.ok(bp0.content.includes('{{SCOPE_INTRO}}'));
    assert.ok(bp0.content.includes('{{ORIGINAL_BASE}}/templates/default.md'));
    assert.equal(bp0.sha256, sha256Hex(bp0.content));

    // Unauthenticated requests to read-only templates return 401
    await req('/api/visual-explainer/templates', { auth: null, status: 401 });
    await req('/api/visual-explainer/templates/default.md', { auth: null, status: 401 });

    // Built-in templates/default.md is auto-discovered in /templates, /templates/default.md, /api/visual-explainer, /bundle, and MCP
    const tplCatalog0 = await (await req('/api/visual-explainer/templates', { status: 200 })).json();
    assert.equal(tplCatalog0.defaultTemplate, 'default');
    assert.equal(tplCatalog0.templates.length, 1);
    assert.equal(tplCatalog0.templates[0].id, 'default');
    assert.equal(tplCatalog0.templates[0].docId, 'templates/default.md');
    assert.equal(tplCatalog0.templates[0].default, true);
    assert.equal(tplCatalog0.templates[0].url, `${baseUrl}/api/visual-explainer/templates/default.md`);
    const defaultTplResp = await req('/api/visual-explainer/templates/default.md', { status: 200 });
    assert.ok(defaultTplResp.headers.get('content-type').startsWith('text/markdown'));
    const defaultTplText = await defaultTplResp.text();
    assert.ok(defaultTplText.includes('Default Wiki & Component Diff'));
    assert.equal(tplCatalog0.templates[0].sha256, sha256Hex(defaultTplText));
    const index0 = await (await req('/api/visual-explainer', { status: 200 })).json();
    assert.equal(index0.templatesUrl, `${baseUrl}/api/visual-explainer/templates`);
    assert.equal(index0.defaultTemplate, 'default');
    assert.deepEqual(index0.templates, tplCatalog0.templates);
    const bundle0 = await (await req('/api/visual-explainer/bundle', { status: 200 })).text();
    const bundleHeader0 = JSON.parse(bundle0.split('\n\n')[0].replace(/^=== \/api\/visual-explainer ===\n/, ''));
    assert.equal(bundleHeader0.templatesUrl, `${baseUrl}/api/visual-explainer/templates`);
    assert.equal(bundleHeader0.defaultTemplate, 'default');
    assert.equal(bundleHeader0.templates[0].id, 'default');
    const mcpDefaultTpl = await (await req('/mcp', {
      method: 'POST',
      auth: adminToken,
      headers: { Accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'visual-explainer://templates/default.md' } },
      status: 200,
    })).json();
    assert.equal(mcpDefaultTpl.result.contents[0].text, defaultTplText);

    // Create regular user account, secondary admin account, folder entity + folder key, and a user page
    const userAcct = await (await req('/api/accounts', { method: 'POST', body: { name: 'Regular User', role: 'user' }, status: 201 })).json();
    const adminAcct = await (await req('/api/accounts', { method: 'POST', body: { name: 'Second Admin', role: 'admin' }, status: 201 })).json();
    const entityRes = await (await req('/api/entities', { method: 'POST', body: { id: 'demo-proj', name: 'Demo Project' }, status: 201 })).json();
    const folderKey = (await (await req(`/api/entities/${entityRes.entity.id}/tokens`, { method: 'POST', body: { name: 'Folder Key', expiresIn: 3600 }, status: 201 })).json()).secret;
    const userPageHtml = '<!doctype html><html><head><title>User Page</title></head><body><p>Hello user page</p></body></html>';
    const userPage = await (await req(`/api/entities/${entityRes.entity.id}/files/user-page.html`, {
      method: 'PUT',
      raw: userPageHtml,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      status: 201,
    })).json();
    await req(`/api/pages/${userPage.page.filename}/comments`, {
      method: 'POST',
      body: { body: 'User page comment' },
      status: 201,
    });

    // 2. Permission isolation: regular user & folder key get 403 on ALL /api/skills/* endpoints
    for (const caller of [userAcct.secret, folderKey]) {
      await req('/api/skills', { auth: caller, status: 403 });
      await req('/api/skills/settings', { method: 'PATCH', auth: caller, body: { editEnabled: true }, status: 403 });
      await req('/api/skills/docs/SKILL.md', { auth: caller, status: 403 });
      await req('/api/skills/docs/SKILL.md', { method: 'PUT', auth: caller, body: { content: 'nope' }, status: 403 });
      await req('/api/skills/templates', { auth: caller, status: 403 });
      await req('/api/skills/templates', { method: 'POST', auth: caller, body: { id: 'nope', content: '# Nope' }, status: 403 });
      await req('/api/skills/templates/default/default', { method: 'PATCH', auth: caller, status: 403 });
      await req('/api/skills/templates/default', { method: 'DELETE', auth: caller, status: 403 });
      await req('/api/skills/keys', { auth: caller, status: 403 });
      await req('/api/skills/comments', { auth: caller, status: 403 });
      await req('/api/skills/events?once=1&timeout=1', { auth: caller, status: 403 });
      // Both can still read /api/visual-explainer/bootstrap-prompt and /api/visual-explainer/templates*
      await req('/api/visual-explainer/bootstrap-prompt', { auth: caller, status: 200 });
      await req('/api/visual-explainer/templates', { auth: caller, status: 200 });
      await req('/api/visual-explainer/templates/default.md', { auth: caller, status: 200 });
    }

    // 3. Server-enforced lock switch (editEnabled === false -> 423 on ALL skill mutations for Admin!)
    await req('/api/skills/docs/SKILL.md', { method: 'PUT', body: { content: '# Locked' }, status: 423 });
    await req('/api/skills/docs/templates/default.md', { method: 'PUT', body: { content: '# Locked' }, status: 423 });
    await req('/api/skills/docs/SKILL.md/reset', { method: 'POST', body: {}, status: 423 });
    await req('/api/skills/templates', { method: 'POST', body: { id: 'postmortem', content: '# Locked' }, status: 423 });
    await req('/api/skills/templates/default/default', { method: 'PATCH', body: {}, status: 423 });
    await req('/api/skills/templates/default', { method: 'DELETE', status: 423 });
    await req('/api/skills/explainers/SKILL', {
      method: 'PUT',
      raw: '<!doctype html><html><body>x</body></html>',
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-VE-Skill-Hash': 'abc' },
      status: 423,
    });
    await req('/api/skills/rollback', { method: 'POST', body: { version: 'v1' }, status: 423 });
    await req('/api/skills/keys', { method: 'POST', body: { name: 'Locked Key' }, status: 423 });
    await req('/api/skills/comments', { method: 'POST', body: { explainerId: 'SKILL', body: 'Locked comment' }, status: 423 });
    await req('/api/skills/comments/c_1/resolve', { method: 'POST', body: {}, status: 423 });
    await req('/api/skills/comments/c_1/reopen', { method: 'POST', body: {}, status: 423 });
    await req('/api/skills/comments/c_1', { method: 'PATCH', body: { body: 'x' }, status: 423 });
    await req('/api/skills/comments/c_1', { method: 'DELETE', status: 423 });
    await req('/api/skills/comments/c_1/dispatch', { method: 'POST', body: {}, status: 423 });

    // Enable skill editing via secondary Admin account -> create ve_sk_ key
    const unlocked = await (await req('/api/skills/settings', {
      method: 'PATCH',
      auth: adminAcct.secret,
      body: { editEnabled: true },
      status: 200,
    })).json();
    assert.equal(unlocked.editEnabled, true);

    const skillKeyRes = await (await req('/api/skills/keys', {
      method: 'POST',
      auth: adminAcct.secret,
      body: { name: 'Skill Maintainer' },
      status: 201,
    })).json();
    assert.match(skillKeyRes.secret, /^ve_sk_/);
    const skillKey = skillKeyRes.secret;

    // Permission isolation for ve_sk_ key: 403 on ALL user library/account/admin-settings/mcp endpoints!
    await req('/api/tree', { auth: skillKey, status: 403 });
    await req('/api/entities', { auth: skillKey, status: 403 });
    await req(`/api/entities/${entityRes.entity.id}/tree`, { auth: skillKey, status: 403 });
    await req(`/api/entities/${entityRes.entity.id}/events?once=1&timeout=1`, { auth: skillKey, status: 403 });
    await req('/api/pages', { auth: skillKey, status: 403 });
    await req(`/api/pages/${userPage.page.filename}`, { auth: skillKey, status: 403 });
    await req('/api/accounts', { auth: skillKey, status: 403 });
    await req('/mcp', { method: 'POST', auth: skillKey, body: {}, status: 403 });
    // ve_sk_ key CANNOT toggle editEnabled or manage keys!
    await req('/api/skills/settings', { method: 'PATCH', auth: skillKey, body: { editEnabled: false }, status: 403 });
    await req('/api/skills/keys', { auth: skillKey, status: 403 });
    await req('/api/skills/keys', { method: 'POST', auth: skillKey, body: { name: 'Nope' }, status: 403 });
    await req(`/api/skills/keys/${skillKeyRes.key.id}`, { method: 'DELETE', auth: skillKey, status: 403 });
    // ve_sk_ key CAN read /api/skills and /api/visual-explainer/*
    await req('/api/skills', { auth: skillKey, status: 200 });
    await req('/api/visual-explainer/SKILL.md', { auth: skillKey, status: 200 });
    await req('/api/visual-explainer/bootstrap-prompt', { auth: skillKey, status: 200 });
    await req('/api/visual-explainer/watch.sh', { auth: skillKey, status: 200 });

    // 4. Live override: PUT /api/skills/docs/SKILL.md immediately affects /bundle, /SKILL.md, and MCP ReadResource!
    const origSkillDoc = await (await req('/api/skills/docs/SKILL.md', { auth: skillKey, status: 200 })).json();
    const origKitCss = await (await req('/api/visual-explainer/kit/kit.css', { auth: skillKey, status: 200 })).text();
    const marker = '\n<!-- TEAM_LIVE_SKILL_OVERRIDE_CANARY -->\n';
    const updatedSkillText = origSkillDoc.content + marker;

    const putDocRes = await (await req('/api/skills/docs/SKILL.md', {
      method: 'PUT',
      auth: skillKey,
      raw: updatedSkillText,
      headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'X-VE-Note': 'Add team canary' },
      status: 200,
    })).json();
    assert.equal(putDocRes.version.label, 'v2');
    assert.equal(putDocRes.skillHash, sha256Hex(updatedSkillText));
    assert.equal(putDocRes.doc.status, 'overridden');

    const servedSkill = await (await req('/api/visual-explainer/SKILL.md', { auth: folderKey, status: 200 })).text();
    assert.equal(servedSkill, updatedSkillText, '/api/visual-explainer/SKILL.md must immediately serve effective override');
    const servedBundle = await (await req('/api/visual-explainer/bundle', { auth: folderKey, status: 200 })).text();
    assert.ok(servedBundle.includes('TEAM_LIVE_SKILL_OVERRIDE_CANARY'), '/api/visual-explainer/bundle must immediately serve effective override');
    const mcpRead = await (await req('/mcp', {
      method: 'POST',
      auth: adminToken,
      headers: { Accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'visual-explainer://skill/SKILL.md' } },
      status: 200,
    })).json();
    assert.equal(mcpRead.result.contents[0].text, updatedSkillText, 'MCP ReadResource must immediately serve effective override');
    const afterKitCss = await (await req('/api/visual-explainer/kit/kit.css', { auth: folderKey, status: 200 })).text();
    assert.equal(afterKitCss, origKitCss, 'kit/kit.css must stay untouched');

    // 5. Strict SHA-256 hash binding on PUT /api/skills/explainers/SKILL + upstream renderer + zero residue!
    const explainerSourceV1 = `<!doctype html>
<html lang="en" data-register="blueprint"><head><title>SKILL Explainer v1</title><meta name="description" content="Visual map of SKILL.md rules"><link rel="stylesheet" href="kit.css" data-ve-kit></head>
<body><main><header><p class="eyebrow">Core Skill</p><h1>SKILL.md Rules</h1></header>
<figure><ve-flow label="SKILL.md guides every render."><ve-node id="skill" at="1 1" key>SKILL.md</ve-node><ve-node id="kit" at="2 1">Kit Renderer</ve-node><ve-edge from="skill" to="kit" label="governs" hot/></ve-flow><figcaption>SKILL.md governs every visual explainer diagram.</figcaption></figure>
</main></body></html>`;

    // Stale hash -> 409 with structured details (rejected BEFORE rendering!)
    const staleRes = await (await req('/api/skills/explainers/SKILL', {
      method: 'PUT',
      auth: skillKey,
      raw: explainerSourceV1,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-VE-Skill-Hash': origSkillDoc.sha256 },
      status: 409,
    })).json();
    assert.equal(staleRes.expectedSkillHash, putDocRes.skillHash);
    assert.equal(staleRes.providedSkillHash, origSkillDoc.sha256);
    assert.deepEqual(staleRes.covers, ['SKILL.md']);

    // Matching hash -> 200, rendered via unmodified upstream renderer, synced=true!
    const pubExp = await (await req('/api/skills/explainers/SKILL', {
      method: 'PUT',
      auth: skillKey,
      raw: explainerSourceV1,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-VE-Skill-Hash': putDocRes.skillHash,
        'X-VE-Title': 'SKILL Core Map',
        'X-VE-Note': 'Initial SKILL explainer',
      },
      status: 200,
    })).json();
    assert.equal(pubExp.synced, true);
    assert.equal(pubExp.version.label, 'v3');
    assert.equal(pubExp.explainer.id, 'SKILL');
    assert.equal(pubExp.explainer.title, 'SKILL Core Map');
    assert.ok(pubExp.render.content.some(item => item.type === 'image'), 'Upstream checksheet image expected');

    // Verify rendered HTML, embed bridge, CSP, raw source, and Light/Dark thumbnails
    const htmlResp = await req('/api/skills/explainers/SKILL/html?embed=1', { auth: skillKey, status: 200 });
    assert.equal(htmlResp.headers.get('content-security-policy'), "sandbox allow-scripts; frame-ancestors 'self'");
    const htmlBody = await htmlResp.text();
    assert.ok(htmlBody.includes('<style data-ve-kit'), 'Upstream kit CSS must be inlined by renderer');
    assert.ok(htmlBody.includes('<svg') && htmlBody.includes('ve-flow'), 'Compiled flow SVG expected');
    assert.ok(!htmlBody.includes('</ve-flow>'), 'Raw <ve-flow> tag must be compiled by upstream renderer');
    assert.ok(htmlBody.includes('data-ve-raft-bridge'), 'embed=1 must inject embed bridge');

    const rawHtmlBody = await (await req('/api/skills/explainers/SKILL/html', { auth: skillKey, status: 200 })).text();
    assert.ok(!rawHtmlBody.includes('data-ve-raft-bridge'), 'Non-embed HTML must remain unmodified');

    const srcBody = await (await req('/api/skills/explainers/SKILL/source', { auth: skillKey, status: 200 })).text();
    assert.equal(srcBody, explainerSourceV1);

    for (const theme of ['light', 'dark']) {
      const thumbRes = await req(`/api/skills/explainers/SKILL/thumb?theme=${theme}`, { auth: skillKey, status: 200 });
      assert.equal(thumbRes.headers.get('content-type'), 'image/png');
      const png = Buffer.from(await thumbRes.arrayBuffer());
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }

    // Multi-segment explainer ID works cleanly too
    const diffDoc = await (await req('/api/skills/docs/commands/diff-review.md', { auth: skillKey, status: 200 })).json();
    const multiPub = await (await req('/api/skills/explainers/commands/diff-review', {
      method: 'PUT',
      auth: skillKey,
      raw: '<!doctype html><html><head><title>Diff Review</title></head><body><h1>Diff Review</h1></body></html>',
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-VE-Skill-Hash': diffDoc.sha256 },
      status: 200,
    })).json();
    assert.equal(multiPub.explainer.id, 'commands/diff-review');
    assert.equal(multiPub.explainer.htmlUrl, '/api/skills/explainers/commands/diff-review/html');
    await req('/api/skills/explainers/commands/diff-review', { auth: skillKey, status: 200 });
    await req('/api/skills/explainers/commands/diff-review/html', { auth: skillKey, status: 200 });
    await req('/api/skills/explainers/commands/diff-review/source', { auth: skillKey, status: 200 });
    await req('/api/skills/explainers/commands/diff-review/thumb?theme=light', { auth: skillKey, status: 200 });

    // ZERO __skill-render- residue in outputDir and /api/tree!
    const diskNames = await readdir(dataDir);
    assert.equal(diskNames.some(name => name.startsWith('__skill-render-')), false, `Transient residue found in outputDir: ${diskNames}`);
    const tree = await (await req('/api/tree', { status: 200 })).json();
    assert.equal(tree.pages.length, 1, 'User library /api/tree must only contain the 1 user page');
    assert.equal(tree.pages[0].filename, userPage.page.filename);

    // 6. Lockstep rollback & reset
    // Edit SKILL.md again (v5) -> breaks sync on SKILL explainer
    const v5Edit = await (await req('/api/skills/docs/SKILL.md', {
      method: 'PUT',
      auth: skillKey,
      body: { content: updatedSkillText + '\nTEMP_BROKEN_RULE\n', note: 'Temp edit' },
      status: 200,
    })).json();
    assert.equal(v5Edit.affectedExplainers.some(e => e.id === 'SKILL'), true);

    const versionsRes = await (await req('/api/skills/versions', { auth: skillKey, status: 200 })).json();
    assert.ok(versionsRes.versions.length >= 5);
    const vDiff = await (await req('/api/skills/versions/v2/diff', { auth: skillKey, status: 200 })).json();
    assert.ok(vDiff.diff.includes('TEAM_LIVE_SKILL_OVERRIDE_CANARY'));

    // Rollback to v3 restores SKILL.md AND bound SKILL explainer in lockstep!
    const rbRes = await (await req('/api/skills/rollback', {
      method: 'POST',
      auth: skillKey,
      body: { version: 'v3', note: 'Rollback to synced v3' },
      status: 200,
    })).json();
    assert.equal(rbRes.rolledBackTo.label, 'v3');
    assert.equal(await (await req('/api/visual-explainer/SKILL.md', { auth: folderKey, status: 200 })).text(), updatedSkillText);
    const skillExpAfterRb = await (await req('/api/skills/explainers/SKILL', { auth: skillKey, status: 200 })).json();
    assert.equal(skillExpAfterRb.synced, true);

    // Reset SKILL.md restores exact upstream Markdown!
    const rstRes = await (await req('/api/skills/docs/SKILL.md/reset', {
      method: 'POST',
      auth: skillKey,
      body: { note: 'Reset SKILL.md' },
      status: 200,
    })).json();
    assert.equal(rstRes.doc.status, 'upstream');
    assert.equal(await (await req('/api/visual-explainer/SKILL.md', { auth: folderKey, status: 200 })).text(), origSkillDoc.content);

    // 6b. Custom template CRUD, live /bundle catalog updates, default switching, deletion guards & rollback!
    const postmortemContent = [
      '---',
      'title: Postmortem Review',
      'whenToUse: Use for incident timelines, fault-domain breakdowns, and corrective actions.',
      '---',
      '',
      '# Postmortem Template',
      '1. L0 incident timeline & impacted systems',
      '2. L1 component root-cause & remediation diff',
      '',
    ].join('\n');
    const createdTpl = await (await req('/api/skills/templates', {
      method: 'POST',
      auth: skillKey,
      body: { id: 'postmortem', content: postmortemContent, note: 'Create postmortem template' },
      status: 201,
    })).json();
    assert.equal(createdTpl.template.id, 'postmortem');
    assert.equal(createdTpl.template.status, 'custom');
    assert.equal(createdTpl.template.builtIn, false);
    await req('/api/skills/templates', {
      method: 'POST',
      auth: skillKey,
      body: { id: 'postmortem', content: '# Duplicate' },
      status: 409,
    });

    // Folder key immediately reads new custom template via /templates, /templates/postmortem.md, and /bundle
    assert.equal(await (await req('/api/visual-explainer/templates/postmortem.md', { auth: folderKey, status: 200 })).text(), postmortemContent);
    const mcpCustomTpl = await (await req('/mcp', {
      method: 'POST',
      auth: adminToken,
      headers: { Accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'visual-explainer://templates/postmortem.md' } },
      status: 200,
    })).json();
    assert.equal(mcpCustomTpl.result.contents[0].text, postmortemContent);

    // Switch default template to postmortem -> /bundle index updates immediately!
    const setDefRes = await (await req('/api/skills/templates/postmortem/default', {
      method: 'PATCH',
      auth: skillKey,
      body: {},
      status: 200,
    })).json();
    assert.equal(setDefRes.defaultTemplate, 'postmortem');
    const bundleWithCustom = await (await req('/api/visual-explainer/bundle', { auth: folderKey, status: 200 })).text();
    const bundleHeaderCustom = JSON.parse(bundleWithCustom.split('\n\n')[0].replace(/^=== \/api\/visual-explainer ===\n/, ''));
    assert.equal(bundleHeaderCustom.defaultTemplate, 'postmortem');
    assert.equal(bundleHeaderCustom.templates[0].id, 'postmortem');
    assert.equal(bundleHeaderCustom.templates[0].default, true);
    assert.equal(bundleHeaderCustom.templates[1].id, 'default');
    assert.equal(bundleHeaderCustom.templates[1].default, false);

    // Prevent deleting built-in default or active default custom template (409)
    await req('/api/skills/templates/default', { method: 'DELETE', auth: skillKey, status: 409 });
    await req('/api/skills/templates/postmortem', { method: 'DELETE', auth: skillKey, status: 409 });

    // Edit custom template via PUT /api/skills/docs/templates/postmortem.md & bind its explainer
    const updatedPostmortem = postmortemContent + '3. Verification & blast-radius checklist\n';
    const updPost = await (await req('/api/skills/docs/templates/postmortem.md', {
      method: 'PUT',
      auth: skillKey,
      body: { content: updatedPostmortem, note: 'Add verification item' },
      status: 200,
    })).json();
    assert.equal(updPost.doc.status, 'custom');
    const postExp = await (await req('/api/skills/explainers/templates/postmortem', {
      method: 'PUT',
      auth: skillKey,
      raw: '<!doctype html><html><head><title>Postmortem Guide</title></head><body><h1>Postmortem</h1></body></html>',
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-VE-Skill-Hash': updPost.skillHash },
      status: 200,
    })).json();
    assert.equal(postExp.synced, true);
    const postmortemSyncedVersion = postExp.version.label;

    // Switch default back to 'default', then delete custom template -> 404 on public fetch and removed from /bundle
    await req('/api/skills/templates/default/default', { method: 'PATCH', auth: skillKey, body: {}, status: 200 });
    const delTpl = await (await req('/api/skills/templates/postmortem', {
      method: 'DELETE',
      auth: skillKey,
      body: { note: 'Remove custom template' },
      status: 200,
    })).json();
    assert.equal(delTpl.deleted, true);
    assert.deepEqual(delTpl.deletedExplainerIds, ['templates/postmortem']);
    await req('/api/visual-explainer/templates/postmortem.md', { auth: folderKey, status: 404 });
    const bundleAfterDel = await (await req('/api/visual-explainer/bundle', { auth: folderKey, status: 200 })).text();
    const bundleHeaderAfterDel = JSON.parse(bundleAfterDel.split('\n\n')[0].replace(/^=== \/api\/visual-explainer ===\n/, ''));
    assert.equal(bundleHeaderAfterDel.defaultTemplate, 'default');
    assert.deepEqual(bundleHeaderAfterDel.templates.map(t => t.id), ['default']);

    // Rollback to version where postmortem existed -> restores custom template AND its explainer cleanly!
    const rbTpl = await (await req('/api/skills/rollback', {
      method: 'POST',
      auth: skillKey,
      body: { version: postmortemSyncedVersion, note: 'Restore postmortem template' },
      status: 200,
    })).json();
    assert.ok(rbTpl.templates.some(t => t.id === 'postmortem'));
    assert.equal(await (await req('/api/visual-explainer/templates/postmortem.md', { auth: folderKey, status: 200 })).text(), updatedPostmortem);
    const restoredPostExp = await (await req('/api/skills/explainers/templates/postmortem', { auth: skillKey, status: 200 })).json();
    assert.equal(restoredPostExp.synced, true);

    // Set default to postmortem, then rollback to v1 (before postmortem existed) -> defaultTemplate safely resets to 'default'!
    await req('/api/skills/templates/postmortem/default', { method: 'PATCH', auth: skillKey, body: {}, status: 200 });
    const rbToV1 = await (await req('/api/skills/rollback', {
      method: 'POST',
      auth: skillKey,
      body: { version: 'v1', note: 'Rollback before custom template' },
      status: 200,
    })).json();
    assert.equal(rbToV1.defaultTemplate, 'default');
    assert.deepEqual(rbToV1.templates.map(t => t.id), ['default']);
    await req('/api/visual-explainer/templates/postmortem.md', { auth: folderKey, status: 404 });

    // 7. Dedicated skill comments + SSE comment.dispatch wakeup (isolated from user comments!)
    const skillComment = await (await req('/api/skills/comments', {
      method: 'POST',
      auth: adminToken,
      body: {
        explainerId: 'SKILL',
        where: { kind: 'element', selector: 'h1', label: 'SKILL.md Rules' },
        body: 'Clarify citation rule on SKILL explainer',
      },
      status: 201,
    })).json();
    assert.equal(skillComment.thread.id, 'c_1');

    // User page comments remain isolated from skill comments
    const userComments = await (await req(`/api/pages/${userPage.page.filename}/comments`, { status: 200 })).json();
    assert.equal(userComments.threads.length, 1);
    assert.equal(userComments.threads[0].body, 'User page comment');
    const skillCommentsList = await (await req('/api/skills/comments?explainer=SKILL&status=open', { auth: skillKey, status: 200 })).json();
    assert.equal(skillCommentsList.threads.length, 1);
    assert.equal(skillCommentsList.threads[0].body, 'Clarify citation rule on SKILL explainer');

    // Start background one-shot SSE listener with ve_sk_ key
    const listenerPromise = fetch(
      new URL('/api/skills/events?events=comment.dispatch&once=1&timeout=30&client=skill-editor-agent', baseUrl),
      { headers: { Authorization: `Bearer ${skillKey}` }, signal: AbortSignal.timeout(35000) },
    );

    // Wait briefly for listener registration and confirm hostCount === 1
    let hostCount = 0;
    for (let i = 0; i < 20; i++) {
      const ov = await (await req('/api/skills', { auth: adminToken, status: 200 })).json();
      hostCount = ov.listeners.hostCount;
      if (hostCount === 1) break;
      await delay(100);
    }
    assert.equal(hostCount, 1, 'Expected 1 active skill event listener');

    // Dispatch thread -> wakes background once=1 listener immediately!
    const dispatchRes = await (await req(`/api/skills/comments/${skillComment.thread.id}/dispatch`, {
      method: 'POST',
      auth: adminToken,
      body: { note: 'Please update SKILL.md and re-render' },
      status: 200,
    })).json();
    assert.equal(dispatchRes.ok, true);
    assert.equal(dispatchRes.deliveredConnections, 1);
    assert.equal(dispatchRes.deliveredHosts, 1);

    const wokenResp = await listenerPromise;
    assert.equal(wokenResp.status, 200);
    const wokenEvent = await wokenResp.json();
    assert.equal(wokenEvent.type, 'comment.dispatch');
    assert.equal(wokenEvent.entityId, '__skills__');
    assert.equal(wokenEvent.filename, 'SKILL');
    assert.equal(wokenEvent.threadId, skillComment.thread.id);
    assert.ok(wokenEvent.summary.includes('Clarify citation rule on SKILL explainer'));

    // Reply, edit, resolve, reopen, delete lifecycle
    await req('/api/skills/comments', {
      method: 'POST',
      auth: skillKey,
      body: { replyTo: skillComment.thread.id, body: 'Working on it' },
      status: 201,
    });
    await req(`/api/skills/comments/${skillComment.thread.id}`, {
      method: 'PATCH',
      auth: adminToken,
      body: { body: 'Clarify citation rule on SKILL explainer (updated)' },
      status: 200,
    });
    const resolved = await (await req(`/api/skills/comments/${skillComment.thread.id}/resolve`, {
      method: 'POST',
      auth: skillKey,
      body: { note: 'Fixed in latest' },
      status: 200,
    })).json();
    assert.equal(resolved.thread.status, 'resolved');
    const reopened = await (await req(`/api/skills/comments/${skillComment.thread.id}/reopen`, {
      method: 'POST',
      auth: adminToken,
      status: 200,
    })).json();
    assert.equal(reopened.thread.status, 'open');

    // 8. Re-locking editEnabled IMMEDIATELY blocks existing ve_sk_ key AND Admin (423), while Admin can still revoke keys!
    await req('/api/skills/settings', { method: 'PATCH', auth: adminToken, body: { editEnabled: false }, status: 200 });
    await req('/api/skills/docs/SKILL.md', { method: 'PUT', auth: skillKey, body: { content: 'blocked' }, status: 423 });
    await req('/api/skills/docs/SKILL.md', { method: 'PUT', auth: adminToken, body: { content: 'blocked' }, status: 423 });
    await req('/api/skills/rollback', { method: 'POST', auth: skillKey, body: { version: 'v1' }, status: 423 });
    await req(`/api/skills/comments/${skillComment.thread.id}/dispatch`, { method: 'POST', auth: adminToken, body: {}, status: 423 });
    await req(`/api/skills/comments/${skillComment.thread.id}`, { method: 'DELETE', auth: adminToken, status: 423 });
    // Admin CAN still revoke the key even while locked
    await req(`/api/skills/keys/${skillKeyRes.key.id}`, { method: 'DELETE', auth: adminToken, status: 204 });
    // Revoked key is immediately 401
    await req('/api/skills', { auth: skillKey, status: 401 });

    // Container restart preserves skills git history, editEnabled=false, comments, and explainers cleanly
    execFileSync('docker', ['restart', containerName], { stdio: 'ignore' });
    await waitHealthy(baseUrl);
    const afterRestart = await (await req('/api/skills', { auth: adminToken, status: 200 })).json();
    assert.equal(afterRestart.editEnabled, false);
    assert.equal(afterRestart.keysCount, 0);
    assert.ok(afterRestart.explainers.some(e => e.id === 'SKILL'));
    const commentsAfterRestart = await (await req('/api/skills/comments?explainer=SKILL', { auth: adminToken, status: 200 })).json();
    assert.equal(commentsAfterRestart.threads.length, 1);
  } catch (error) {
    failed = true;
    try {
      const logs = execFileSync('docker', ['logs', '--tail', '60', containerName], { encoding: 'utf8' });
      console.error('Container logs:\n' + logs);
    } catch {}
    throw error;
  } finally {
    try { execFileSync('docker', ['rm', '--force', containerName], { stdio: 'ignore' }); } catch {}
    try {
      execFileSync('docker', [
        'run', '--rm', '--user', '0',
        '--mount', `type=bind,src=${fixture},dst=/fixture`,
        TEST_IMAGE,
        'chown', '-hR', `${process.getuid()}:${process.getgid()}`, '/fixture',
      ], { stdio: 'ignore' });
    } catch {}
    await rm(fixture, { recursive: true, force: true }).catch(() => {});
    if (failed) {
      // already logged above
    }
  }
});
