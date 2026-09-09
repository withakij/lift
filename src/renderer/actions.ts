/**
 * Every operation the interface can perform. Views call these; nothing in a
 * view talks to the bridge directly, so behaviour stays in one place.
 */
import { api } from './lib/api.js';
import { guard, toast } from './lib/ui.js';
import {
  currentProject,
  getState,
  loadExports,
  loadIssues,
  loadProducts,
  loadProjectData,
  loadProjects,
  patch,
  refreshForView,
  setView,
  switchProject
} from './lib/state.js';
import type { ExportOptions, TargetFormat } from '../shared/types';
import { plural } from './lib/format.js';

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

export async function createProject(input: {
  name: string;
  description: string;
  targetFormat: TargetFormat;
  exportProfileId: string;
}): Promise<void> {
  const project = await guard(() => api.projects.create(input), 'Could not create the project.');
  if (!project) return;
  await loadProjects();
  await switchProject(project.id);
  toast(`Project “${project.name}” is ready.`);
  setView('categories');
}

export async function updateProject(id: string, patchData: Record<string, unknown>): Promise<void> {
  const ok = await guard(() => api.projects.update(id, patchData), 'Could not save the project.');
  if (!ok) return;
  await loadProjects();
  toast('Project updated.');
}

export async function deleteProject(id: string): Promise<void> {
  const ok = await guard(async () => {
    await api.projects.remove(id);
    return true;
  }, 'Could not delete the project.');
  if (!ok) return;
  await loadProjects();
  await switchProject(getState().projects[0]?.id ?? null);
  toast('Project deleted.');
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

export async function createCategory(name: string, path: string): Promise<void> {
  const projectId = getState().projectId;
  if (!projectId) return;
  const created = await guard(
    () => api.categories.create({ projectId, name, path: path || name }),
    'Could not create the category.'
  );
  if (!created) return;
  await loadProjectData();
  toast(`Category “${created.name}” added.`);
}

export async function renameCategory(id: string, name: string, path: string): Promise<void> {
  const ok = await guard(() => api.categories.update(id, { name, path: path || name }), 'Could not rename the category.');
  if (!ok) return;
  await loadProjectData();
  await loadProducts();
  toast('Category renamed. Products already collected were updated too.');
}

export async function deleteCategory(id: string, deleteUrls: boolean): Promise<void> {
  const ok = await guard(async () => {
    await api.categories.remove(id, { deleteUrls });
    return true;
  }, 'Could not delete the category.');
  if (!ok) return;
  await loadProjectData();
  toast(deleteUrls ? 'Category and its URLs were deleted.' : 'Category deleted; its URLs were kept.');
}

/* ------------------------------------------------------------------ */
/* URLs                                                                */
/* ------------------------------------------------------------------ */

export async function addUrls(text: string, categoryId: string | null): Promise<void> {
  const projectId = getState().projectId;
  if (!projectId) return;
  const res = await guard(
    () => api.urls.addBulk({ projectId, categoryId, text }),
    'Could not add those addresses.'
  );
  if (!res) return;
  await loadProjectData();

  const parts: string[] = [];
  if (res.added) parts.push(`${plural(res.added, 'URL')} added`);
  if (res.duplicates) parts.push(`${res.duplicates} already in this project`);
  if (res.invalid.length) parts.push(`${res.invalid.length} not recognised`);
  const tone = res.added ? (res.invalid.length ? 'warn' : 'ok') : 'warn';
  toast(parts.join(' · ') || 'Nothing to add.', tone);
}

export async function importUrlFile(categoryId: string | null): Promise<void> {
  const projectId = getState().projectId;
  if (!projectId) return;
  const res = await guard(() => api.urls.importFile(projectId, categoryId), 'Could not read that file.');
  if (!res || res.cancelled) return;
  await loadProjectData();
  toast(`${plural(res.added, 'URL')} imported · ${res.duplicates} duplicates skipped.`);
}

export async function editUrl(id: string, url: string): Promise<void> {
  const ok = await guard(() => api.urls.update(id, { url }), 'Could not update the address.');
  if (!ok) return;
  await loadProjectData();
  toast('Address updated. It will be collected again on the next run.');
}

export async function removeUrls(ids: string[]): Promise<void> {
  const ok = await guard(async () => {
    await api.urls.removeMany(ids);
    return true;
  }, 'Could not remove those addresses.');
  if (!ok) return;
  getState().selection.urls.clear();
  await loadProjectData();
  toast(`${plural(ids.length, 'URL')} removed.`);
}

export async function moveUrls(ids: string[], categoryId: string | null): Promise<void> {
  const ok = await guard(async () => {
    await api.urls.move(ids, categoryId);
    return true;
  }, 'Could not move those addresses.');
  if (!ok) return;
  getState().selection.urls.clear();
  await loadProjectData();
  toast(`${plural(ids.length, 'URL')} moved.`);
}

export async function resetUrls(ids: string[]): Promise<void> {
  const ok = await guard(async () => {
    await api.urls.resetState(ids);
    return true;
  }, 'Could not reset those addresses.');
  if (!ok) return;
  await loadProjectData();
  toast(`${plural(ids.length, 'URL')} queued to be collected again.`);
}

/* ------------------------------------------------------------------ */
/* Scraping                                                            */
/* ------------------------------------------------------------------ */

export async function startScrape(scope: { categoryIds?: string[]; urlIds?: string[] }): Promise<void> {
  const projectId = getState().projectId;
  if (!projectId) return;
  const job = await guard(() => api.scrape.start({ projectId, ...scope }), 'Could not start collecting.');
  if (!job) return;
  setView('scraping');
  await loadProjectData();
}

export async function pauseScrape(): Promise<void> {
  await guard(() => api.scrape.pause());
}

export async function resumeScrape(): Promise<void> {
  await guard(() => api.scrape.resume());
}

export async function cancelScrape(): Promise<void> {
  await guard(() => api.scrape.cancel());
  await loadProjectData();
}

export async function retryFailed(): Promise<void> {
  const projectId = getState().projectId;
  if (!projectId) return;
  const job = await guard(() => api.scrape.retryFailed(projectId), 'Could not retry.');
  if (!job) {
    toast('There are no failed addresses to retry.', 'warn');
    return;
  }
  setView('scraping');
  await loadProjectData();
}

export async function rescrapeProducts(ids: string[]): Promise<void> {
  const job = await guard(() => api.scrape.rescrape(ids), 'Could not start collecting again.');
  if (!job) {
    toast('Those products have no matching URL in this project any more.', 'warn');
    return;
  }
  setView('scraping');
  await loadProjectData();
}

/* ------------------------------------------------------------------ */
/* Products                                                            */
/* ------------------------------------------------------------------ */

export async function deleteProducts(ids: string[]): Promise<void> {
  const ok = await guard(async () => {
    await api.products.remove(ids);
    return true;
  }, 'Could not delete those products.');
  if (!ok) return;
  getState().selection.products.clear();
  await loadProducts();
  await loadProjectData();
  toast(`${plural(ids.length, 'product')} deleted.`);
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export async function runValidation(): Promise<void> {
  const projectId = getState().projectId;
  if (!projectId) return;
  const summary = await guard(() => api.validation.run(projectId), 'Validation could not run.');
  if (!summary) return;
  await loadIssues();
  await loadProjectData();
  setView('validation');
  const blocking = summary.bySeverity.CRITICAL + summary.bySeverity.ERROR;
  if (summary.issueCount === 0) {
    toast('Everything checks out — no findings.');
  } else if (blocking === 0) {
    toast(`${plural(summary.issueCount, 'finding')}, none of them blocking.`);
  } else {
    toast(`${plural(blocking, 'issue')} need attention before export.`, 'warn', 7000);
  }
}

export async function acknowledgeIssues(ids: string[], value: boolean): Promise<void> {
  await guard(async () => {
    await api.validation.acknowledge(ids, value);
    return true;
  });
  await loadIssues();
}

/* ------------------------------------------------------------------ */
/* Exports                                                             */
/* ------------------------------------------------------------------ */

export async function runExport(opts: ExportOptions): Promise<void> {
  const record = await guard(() => api.exports.run(opts), 'The export could not be written.');
  if (!record) return;
  await loadExports();
  await loadProjectData();
  if (record.status === 'failed') {
    toast('Nothing was exported — every product was held back. Check the validation findings.', 'warn', 8000);
  } else {
    toast(`${plural(record.rowCount, 'row')} written to ${record.filePath.split(/[/\\]/).pop()}`, record.status === 'partial' ? 'warn' : 'ok', 7000);
  }
}

export async function revealExport(filePath: string): Promise<void> {
  await guard(async () => {
    await api.exports.reveal(filePath);
    return true;
  }, 'Could not open that folder.');
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export async function saveSettings(patchData: Record<string, unknown>): Promise<void> {
  const next = await guard(() => api.settings.set(patchData), 'Could not save settings.');
  if (!next) return;
  patch({ settings: next });
  document.documentElement.setAttribute('data-theme', next.theme);
}

export async function chooseExportFolder(): Promise<string | null> {
  const dir = await guard(() => api.system.chooseDirectory());
  return dir ?? null;
}

export async function openExternal(url: string): Promise<void> {
  await guard(async () => {
    await api.system.openExternal(url);
    return true;
  }, 'Could not open that link.');
}

export async function testUrl(url: string): Promise<{ platform: string; reachable: boolean; status: number | null; detail: string } | undefined> {
  return guard(() => api.scrape.testUrl(url));
}

export { refreshForView, currentProject };
