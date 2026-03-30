/* @meta
{
  "name": "nsmc/cart-clear",
  "description": "清空当前 NSMC DataPortal 购物车；默认仅预览，传入 --confirm yes 才会真正清空",
  "domain": "satellite.nsmc.org.cn",
  "args": {
    "confirm": {"required": false, "description": "传 yes 才会真正清空购物车"}
  },
  "capabilities": ["network"],
  "readOnly": false,
  "example": "bb-browser site nsmc/cart-clear --confirm yes"
}
*/

async function(args) {
  const confirm = /^(1|true|yes|y|on)$/i.test(String(args.confirm || ''));
  let cachedTokenPromise = null;

  const formatBytes = (bytes) => {
    const n = Number(bytes || 0);
    if (!Number.isFinite(n)) return null;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = n;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
      value /= 1024;
      idx++;
    }
    return value.toFixed(idx === 0 ? 0 : 2) + ' ' + units[idx];
  };

  async function getToken() {
    if (!cachedTokenPromise) {
      cachedTokenPromise = fetch('/DataPortal/v1/data/selection/token', {credentials: 'include'})
        .then(async (resp) => {
          if (!resp.ok) throw new Error('Token HTTP ' + resp.status);
          const data = await resp.json().catch(() => null);
          if (!data || data.status !== 1 || !data.resource) throw new Error(data?.message || 'Failed to get CSRF token');
          return data.resource;
        });
    }
    return cachedTokenPromise;
  }

  async function apiFetch(url, options = {}) {
    const token = await getToken();
    const headers = new Headers(options.headers || {});
    if (!headers.has('Csrf-Token')) headers.set('Csrf-Token', token);
    return fetch(url, {...options, credentials: 'include', headers});
  }

  async function fetchJsonWithRetry(url, options = {}, attempts = 3) {
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const resp = await apiFetch(url, options);
        const text = await resp.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
        }
        if (!resp.ok) {
          return {ok: false, status: resp.status, data, text};
        }
        if (data == null) {
          lastError = new Error('Invalid JSON response');
        } else {
          return {ok: true, status: resp.status, data, text};
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
      }
    }
    throw lastError || new Error('Failed to fetch');
  }

  async function getCartState() {
    const statsResp = await fetchJsonWithRetry('/DataPortal/v1/data/cart/substats');
    const sizeResp = await fetchJsonWithRetry('/DataPortal/v1/data/cart/subsize');
    if (!statsResp.ok) {
      return {error: 'cart/substats HTTP ' + statsResp.status, hint: 'Please log in to the NSMC DataPortal first'};
    }
    if (!sizeResp.ok) {
      return {error: 'cart/subsize HTTP ' + sizeResp.status, hint: 'Please log in to the NSMC DataPortal first'};
    }
    const statsData = statsResp.data;
    const sizeData = sizeResp.data;
    if (statsData.status !== 1) return {error: statsData.message || ('API status ' + statsData.status), status: statsData.status};
    if (sizeData.status !== 1) return {error: sizeData.message || ('API status ' + sizeData.status), status: sizeData.status};

    const stats = statsData.resource || {};
    const size = sizeData.resource || {};
    const summary = {
      cartFileCount: Number(stats.cartFileCount || stats.subFileCount || stats.fileCount || stats.shopcount || 0),
      cartSizeBytes: Number(size.sizeOfShop || stats.subFileSize || stats.sizeOfShop || 0),
      cartSizeHuman: formatBytes(size.sizeOfShop || stats.subFileSize || stats.sizeOfShop || 0),
      orderedSizeBytes: Number(size.sizeOfOrd || 0),
      orderedSizeHuman: formatBytes(size.sizeOfOrd || 0),
      totalOrdAndShopBytes: Number(size.sizeOfOrdAndShop || 0),
      totalOrdAndShopHuman: formatBytes(size.sizeOfOrdAndShop || 0),
      maxFileDownloadCount: size.maxfiledownloadcount || null,
      remainDmzFileSizeBytes: stats.remainDmzFileSize != null ? Number(stats.remainDmzFileSize) : null,
      remainDmzFileSizeHuman: stats.remainDmzFileSize != null ? formatBytes(stats.remainDmzFileSize) : null
    };

    return {summary, stats, size};
  }

  function collectSelectedFromDocument(doc) {
    const pick = (name) => Array.from(doc.querySelectorAll(`input[type="checkbox"][name="${name}"]:checked`))
      .map((el) => (el.value || '').trim())
      .filter(Boolean);
    return {
      satelliteList: pick('satellite'),
      channelList: pick('channel'),
      productNameList: pick('productName'),
      productTypeList: pick('productType'),
      resolutionList: pick('resolution'),
      startTimeList: pick('startTime'),
      startHourList: pick('startHour'),
      receivesList: pick('receives')
    };
  }

  function countSelectionValues(selection) {
    return Object.values(selection || {}).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
  }

  function normalizeLabelSelection(label) {
    const asArray = (value) => Array.isArray(value) ? value : [];
    const clean = (value) => asArray(value)
      .map((item) => item == null ? '' : String(item).trim())
      .filter(Boolean);
    return {
      satelliteList: clean(label?.satellite),
      channelList: clean(label?.channel),
      productNameList: clean(label?.productCode),
      productTypeList: clean(label?.productType),
      resolutionList: clean(label?.resolution),
      startTimeList: clean(label?.startTime),
      startHourList: clean(label?.startHour),
      receivesList: clean(label?.receives)
    };
  }

  async function getDeleteSelection(cartState) {
    if (Number(cartState?.summary?.cartFileCount || 0) === 0 || Number(cartState?.summary?.cartSizeBytes || 0) === 0) {
      return {
        satelliteList: [],
        channelList: [],
        productNameList: [],
        productTypeList: [],
        resolutionList: [],
        startTimeList: [],
        startHourList: [],
        receivesList: []
      };
    }

    const fromLivePage = (() => {
      try {
        if (typeof findCheckedInfo === 'function' && /\/DataPortal\/.*\/data\/cart\.html/i.test(location.href)) {
          return {
            satelliteList: findCheckedInfo('satellite'),
            channelList: findCheckedInfo('channel'),
            productNameList: findCheckedInfo('productName'),
            productTypeList: findCheckedInfo('productType'),
            resolutionList: findCheckedInfo('resolution'),
            startTimeList: findCheckedInfo('startTime'),
            startHourList: findCheckedInfo('startHour'),
            receivesList: findCheckedInfo('receives')
          };
        }
      } catch {
      }
      return null;
    })();

    const liveCount = fromLivePage ? countSelectionValues(fromLivePage) : 0;
    if (liveCount > 0) return fromLivePage;

    const subInfoResp = await fetchJsonWithRetry('/DataPortal/v1/data/cart/subinfo?page=1');
    if (subInfoResp.ok && subInfoResp.data?.status === 1) {
      const fromLabel = normalizeLabelSelection(subInfoResp.data?.resource?.label || {});
      if (countSelectionValues(fromLabel) > 0) {
        return fromLabel;
      }
    }

    const pageResp = await fetch('/DataPortal/cn/data/cart.html', {credentials: 'include'});
    if (!pageResp.ok) {
      return {error: 'cart page HTTP ' + pageResp.status};
    }
    const html = await pageResp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const parsed = collectSelectedFromDocument(doc);
    const parsedCount = countSelectionValues(parsed);

    if (parsedCount > 0 || Number(cartState?.summary?.cartFileCount || 0) === 0) {
      return parsed;
    }

    return {
      error: 'Could not determine cart selection filters from the cart page',
      hint: 'Open the cart page and retry'
    };
  }

  function summarizeSelection(selection) {
    return {
      satelliteCount: selection.satelliteList.length,
      channelCount: selection.channelList.length,
      productNameCount: selection.productNameList.length,
      productTypeCount: selection.productTypeList.length,
      resolutionCount: selection.resolutionList.length,
      startTimeCount: selection.startTimeList.length,
      startHourCount: selection.startHourList.length,
      receivesCount: selection.receivesList.length,
      temp: 1,
      fileNameCount: 0
    };
  }

  try {
    const before = await getCartState();
    if (before.error) return before;

    const selection = await getDeleteSelection(before);
    if (selection?.error) {
      return {
        error: selection.error,
        hint: selection.hint || null,
        cartBefore: before.summary
      };
    }

    const preview = {
      preview: !confirm,
      cartBefore: before.summary,
      selectionSummary: summarizeSelection(selection),
      alreadyEmpty: Number(before.summary.cartFileCount || 0) === 0 || Number(before.summary.cartSizeBytes || 0) === 0
    };

    if (!confirm) {
      return {
        ...preview,
        hint: preview.alreadyEmpty ? 'Cart is already empty' : 'Re-run with --confirm yes to clear the current cart'
      };
    }

    if (preview.alreadyEmpty) {
      return {
        ...preview,
        preview: false,
        cleared: false,
        verifiedEmpty: true,
        cartAfter: before.summary
      };
    }

    const payload = {
      ...selection,
      temp: 1,
      fileNameList: []
    };
    const deleteResp = await fetchJsonWithRetry('/DataPortal/v1/data/cart/subfile', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(payload)
    });
    if (!deleteResp.ok) {
      return {
        error: 'cart/subfile HTTP ' + deleteResp.status,
        cartBefore: before.summary,
        selectionSummary: preview.selectionSummary
      };
    }
    if (deleteResp.data.status !== 1) {
      return {
        error: deleteResp.data.message || ('API status ' + deleteResp.data.status),
        status: deleteResp.data.status,
        cartBefore: before.summary,
        selectionSummary: preview.selectionSummary
      };
    }

    let after = null;
    for (let i = 0; i < 5; i++) {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 400 * i));
      }
      after = await getCartState();
      if (!after.error && Number(after.summary.cartFileCount || 0) === 0 && Number(after.summary.cartSizeBytes || 0) === 0) {
        break;
      }
    }

    return {
      ...preview,
      preview: false,
      cleared: true,
      response: deleteResp.data,
      cartAfter: after?.summary || null,
      verifiedEmpty: !after?.error && Number(after.summary?.cartFileCount || 0) === 0 && Number(after.summary?.cartSizeBytes || 0) === 0
    };
  } catch (error) {
    return {error: error.message || String(error)};
  }
}
