/* @meta
{
  "name": "nsmc/order-submit",
  "description": "提交当前 NSMC DataPortal 购物车；默认先预览购物车和额度摘要，传入 --confirm yes 才会真正提交",
  "domain": "satellite.nsmc.org.cn",
  "args": {
    "confirm": {"required": false, "description": "传 yes 才会真正提交购物车"},
    "sendMail": {"required": false, "description": "yes 或 no，默认 yes"},
    "ftpMode": {"required": false, "description": "radioBtnlist_ftp 的取值，默认 0"},
    "zipFileStatus": {"required": false, "description": "zipfilestatus 的取值，默认 -1"},
    "cloudStatus": {"required": false, "description": "cloudStatus 的取值，默认 2"},
    "ordSource": {"required": false, "description": "订单来源，默认 NewPortalCH"}
  },
  "capabilities": ["network"],
  "readOnly": false,
  "example": "bb-browser site nsmc/order-submit --sendMail yes --confirm yes"
}
*/

async function(args) {
  const confirm = /^(1|true|yes|y|on)$/i.test(String(args.confirm || ''));
  const sendMail = !/^(0|false|no|n|off)$/i.test(String(args.sendMail || 'yes'));
  const ftpMode = String(args.ftpMode || '0');
  const zipFileStatus = String(args.zipFileStatus || '-1');
  const cloudStatus = String(args.cloudStatus || '2');
  const ordSource = String(args.ordSource || 'NewPortalCH');
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

  const buildQuotaSummary = (stats, size) => {
    const cartFileCount = Number(stats?.cartFileCount || stats?.subFileCount || stats?.fileCount || stats?.shopcount || 0);
    const cartSizeBytes = Number(size?.sizeOfShop || stats?.subFileSize || stats?.sizeOfShop || 0);
    const orderedSizeBytes = Number(size?.sizeOfOrd || 0);
    const totalOrdAndShopBytes = Number(size?.sizeOfOrdAndShop || 0);
    const remainDmzFileSizeBytes = stats?.remainDmzFileSize != null ? Number(stats.remainDmzFileSize) : null;
    const maxFileDownloadCount = size?.maxfiledownloadcount != null ? Number(size.maxfiledownloadcount) : null;
    const fitsDailyVolumeLimit = remainDmzFileSizeBytes != null ? cartSizeBytes <= remainDmzFileSizeBytes : null;
    const overflowBytes = remainDmzFileSizeBytes != null ? Math.max(0, cartSizeBytes - remainDmzFileSizeBytes) : null;
    const retainRatio = remainDmzFileSizeBytes != null && cartSizeBytes > 0
      ? Math.max(0, Math.min(1, remainDmzFileSizeBytes / cartSizeBytes))
      : null;

    return {
      cartFileCount,
      cartSizeBytes,
      cartSizeHuman: formatBytes(cartSizeBytes),
      orderedSizeBytes,
      orderedSizeHuman: formatBytes(orderedSizeBytes),
      totalOrdAndShopBytes,
      totalOrdAndShopHuman: formatBytes(totalOrdAndShopBytes),
      maxFileDownloadCount,
      remainDmzFileSizeBytes,
      remainDmzFileSizeHuman: remainDmzFileSizeBytes != null ? formatBytes(remainDmzFileSizeBytes) : null,
      fitsDailyVolumeLimit,
      overflowBytes,
      overflowHuman: overflowBytes != null ? formatBytes(overflowBytes) : null,
      retainRatio
    };
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

  try {
    const statsResp = await apiFetch('/DataPortal/v1/data/cart/substats');
    if (!statsResp.ok) {
      return {
        error: 'cart/substats HTTP ' + statsResp.status,
        hint: statsResp.status === 401 || statsResp.status === 403 ? 'Please log in to the NSMC DataPortal first' : 'Could not inspect cart before submit'
      };
    }

    const statsData = await statsResp.json();
    if (statsData.status !== 1) return {error: statsData.message || ('API status ' + statsData.status), status: statsData.status};

    const sizeResp = await apiFetch('/DataPortal/v1/data/cart/subsize');
    const sizeData = sizeResp.ok ? await sizeResp.json().catch(() => null) : null;
    const quotaSummary = buildQuotaSummary(statsData.resource || {}, sizeData?.status === 1 ? sizeData.resource || {} : {});

    const preview = {
      preview: !confirm,
      sendMail,
      ordSource,
      ftpMode,
      zipFileStatus,
      cloudStatus,
      cartStats: statsData.resource,
      cartSize: sizeData?.status === 1 ? {
        ...sizeData.resource,
        sizeOfShopHuman: formatBytes(sizeData.resource?.sizeOfShop || 0),
        sizeOfOrdHuman: formatBytes(sizeData.resource?.sizeOfOrd || 0),
        sizeOfOrdAndShopHuman: formatBytes(sizeData.resource?.sizeOfOrdAndShop || 0)
      } : null,
      quotaSummary
    };

    if (!confirm) {
      return {
        ...preview,
        hint: 'Re-run with --confirm yes to submit the current cart'
      };
    }

    const body = {
      ordSource,
      chkIsPushMode: true,
      chkIsSendMail: sendMail,
      radioBtnlist_ftp: ftpMode,
      zipfilestatus: zipFileStatus,
      cloudStatus
    };
    const submitResp = await apiFetch('/DataPortal/v1/data/order/suborder', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8'
      },
      body: JSON.stringify(body)
    });
    if (!submitResp.ok) return {error: 'order/suborder HTTP ' + submitResp.status, ...preview};

    const submitData = await submitResp.json().catch(() => null);
    if (!submitData) return {error: 'Invalid JSON response from order/suborder', ...preview};

    if (submitData.status !== 1) {
      return {
        error: submitData.message || ('API status ' + submitData.status),
        status: submitData.status,
        ...preview
      };
    }

    return {
      ...preview,
      preview: false,
      submitted: true,
      response: submitData
    };
  } catch (error) {
    return {error: error.message || String(error)};
  }
}
