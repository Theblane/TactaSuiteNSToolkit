/**
 * TactaSuite NS Toolkit — NetSuite Page Detector
 *
 * @author Blane Maher
 */

export interface PageDescriptor {
    type: string;
    recordType: string | null;
    recordId: string | null;
    isEdit: boolean;
    searchId: string | null;
}

export namespace TactaPageDetector {
  const URL_RULES: { pattern: RegExp; type: string }[] = [
    { pattern: /\/app\/common\/workflow\/setup\//i,        type: 'workflow' },
    { pattern: /\/app\/common\/scripting\/script\.nl/i,    type: 'script-record' },
    { pattern: /\/app\/common\/dataset\//i,                type: 'dataset' },
    { pattern: /\/app\/common\/workbook\//i,               type: 'workbook' },
    { pattern: /\/app\/common\/scripting\/scripttemplate\.nl/i, type: 'pdf-template' },
    { pattern: /\/app\/common\/custom\/custhtml\.nl/i,          type: 'pdf-template' },
    { pattern: /\/app\/setup\/assistants\/nsimport\//i,    type: 'csv-import' },
    { pattern: /\/app\/common\/media\//i,                  type: 'file-cabinet' },
    { pattern: /\/app\/common\/search\/searchresults\.nl/i,        type: 'search-results' },
    { pattern: /\/app\/common\/search\/search\.nl.*&e=T/i,         type: 'search-edit' },
    { pattern: /\/app\/common\/search\/search\.nl/i,               type: 'search-edit' },
    { pattern: /\/app\/common\/search\/searchlist\.nl/i,           type: 'search-list' },
    { pattern: /\/app\/common\/search\//i,                         type: 'search-list' },
    { pattern: /\/app\/setup\//i,                          type: 'setup' },
    { pattern: /\/app\/center\/card\.nl/i,                 type: 'dashboard' },
    { pattern: /\/app\/site\/hosting\/scriptlet\.nl/i,     type: 'suitelet' },
    { pattern: /\/app\/accounting\/transactions\/transactionlist\.nl/i, type: 'list' },
    { pattern: /\/app\/common\/entity\/.*list\.nl/i,       type: 'list' },
    { pattern: /\/app\/accounting\/transactions\//i,       type: '_transaction' },
    { pattern: /\/app\/common\/custom\/custrecordentry\.nl/i, type: '_record' },
    { pattern: /\/app\/common\/entity\//i,                 type: '_record' },
    { pattern: /list\.nl/i,                                type: 'list' }
  ];

  function parseQuery(url: string): Record<string, string> {
    const params: Record<string, string> = {};
    const qs = url.split('?')[1];
    if (!qs) return params;
    qs.split('&').forEach((pair) => {
      const [key, val] = pair.split('=');
      params[decodeURIComponent(key).toLowerCase()] = decodeURIComponent(val || '');
    });
    return params;
  }

  function detectRecordType(params: Record<string, string>): string | null {
    if (params.rectype)     return params.rectype;
    if (params.recordtype)  return params.recordtype;
    if (params.type)        return params.type;

    const hiddenInput = document.querySelector('input[name="type"], input[name="baserecordtype"]') as HTMLInputElement;
    if (hiddenInput?.value) return hiddenInput.value;

    return null;
  }

  function detectEditMode(params: Record<string, string>): boolean {
    if (params.e === 't' || params.e === 'T') return true;
    if (!params.id && params.rectype) return true;

    const mainForm = document.getElementById('main_form') as HTMLFormElement;
    if (mainForm?.action && /[?&]e=T/i.test(mainForm.action)) return true;

    return false;
  }

  export function detect(): PageDescriptor {
    const url    = window.location.href;
    const params = parseQuery(url);

    let type = 'other';
    for (const rule of URL_RULES) {
      if (rule.pattern.test(url)) {
        type = rule.type;
        break;
      }
    }

    const isEdit     = detectEditMode(params);
    const recordType = detectRecordType(params);
    const recordId   = params.id || null;
    const searchId   = params.searchid || params.id || null;

    if (type === '_transaction' || type === '_record') {
      type = isEdit ? 'record-edit' : 'record-view';
    }

    return {
      type,
      recordType,
      recordId,
      isEdit,
      searchId: (type.startsWith('search') ? searchId : null)
    };
  }
}

// Global exposure
if (typeof window !== 'undefined') {
  (window as any).TactaPageDetector = TactaPageDetector;
}
