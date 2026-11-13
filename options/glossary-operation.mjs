// A storage operation must finish before its editor can change to another draft.
import { MSG, t, ui } from './context.mjs';
import { restoreFocus, sendMessage } from './utils.mjs';

let busy = false;

export function glossaryBusy() {
  return busy;
}

/** Mutations share the worker's per-work queue with chapter extraction and automatic tidy. */
export async function editGlossary(entry, action, values = {}) {
  const reply = await sendMessage({
    type: MSG.GLOSSARY_EDIT,
    siteId: entry.siteId,
    workId: entry.workId,
    targetCode: entry.targetCode,
    action,
    ...values
  });
  if (!reply || reply.ok !== true) {
    throw Object.assign(new Error(reply?.error?.message || t('opt_glossary_operation_failed')), {
      code: reply?.error?.code
    });
  }
  return reply;
}

export function beginGlossaryOperation() {
  if (busy) return null;
  busy = true;
  const focused = document.activeElement;
  for (const element of [ui.glossaryEditor, ui.glossaryList]) {
    if (!element) continue;
    element.inert = true;
    element.setAttribute('aria-busy', 'true');
  }
  if (ui.glossaryRefreshButton) ui.glossaryRefreshButton.disabled = true;
  return () => {
    busy = false;
    for (const element of [ui.glossaryEditor, ui.glossaryList]) {
      if (!element) continue;
      element.inert = false;
      element.removeAttribute('aria-busy');
    }
    if (ui.glossaryRefreshButton) ui.glossaryRefreshButton.disabled = false;
    restoreFocus(focused, ui.glossaryEditor?.hidden ? ui.glossaryRefreshButton : ui.glossarySaveButton);
  };
}
