/* @meta
{
  "name": "nsmc/cart-add",
  "description": "将指定 NSMC DataPortal 产品和日期范围批量加入购物车；默认仅预览，传入 --confirm yes 才会真正加入；支持自动按天回退切分",
  "domain": "satellite.nsmc.org.cn",
  "args": {
    "beginDate": {"required": true, "description": "开始日期，格式 YYYY-MM-DD；也兼容 YYYY-M-D"},
    "endDate": {"required": true, "description": "结束日期，格式 YYYY-MM-DD；也兼容 YYYY-M-D"},
    "datatype": {"required": false, "description": "未提供 product 时使用的数据类型，如 CTH 或 CTP"},
    "timeSelection": {"required": false, "description": "时间筛选，如 00、15、30、45、all；默认 00"},
    "confirm": {"required": false, "description": "传 yes 才会真正加入购物车；否则只返回预览结果"},
    "product": {"required": false, "description": "精确的 filenamecode；传入后会覆盖 datatype 查找"},
    "satellite": {"required": false, "description": "卫星代码，默认 FY4B"},
    "instrument": {"required": false, "description": "仪器代码，默认 AGRI"},
    "areatype": {"required": false, "description": "区域类型，默认 DISK"},
    "beginTime": {"required": false, "description": "开始时间，默认 00:00:00"},
    "endTime": {"required": false, "description": "结束时间，默认 23:59:59"},
    "beginIndex": {"required": false, "description": "分页起始索引，默认 1"},
    "endIndex": {"required": false, "description": "分页结束索引，默认 10"},
    "autoFallback": {"required": false, "description": "yes（默认）时自动切分长区间，并在剩余额度不足时自动缩短最后一段"},
    "maxSpanDays": {"required": false, "description": "单段最大天数，默认 92"},
    "minChunkDays": {"required": false, "description": "自动回退最小切分单位，按天计，默认 1"},
    "shrinkDirection": {"required": false, "description": "earliest（默认）固定 beginDate；latest 固定 endDate"}
  },
  "capabilities": ["network"],
  "readOnly": false,
  "example": "bb-browser site nsmc/cart-add 2023-11-05 2023-12-31 --datatype CTH --timeSelection 00 --confirm yes"
}
*/

async function(args) {
  const satellite = (args.satellite || 'FY4B').trim();
  const instrument = (args.instrument || 'AGRI').trim();
  const areatype = (args.areatype || 'DISK').trim();
  const rawBeginDate = (args.beginDate || '').trim();
  const rawEndDate = (args.endDate || '').trim();
  const beginTime = (args.beginTime || '00:00:00').trim();
  const endTime = (args.endTime || '23:59:59').trim();
  const timeSelection = (args.timeSelection || '00').trim();
  const beginIndex = Math.max(1, parseInt(args.beginIndex || '1', 10) || 1);
  const endIndex = Math.max(beginIndex, parseInt(args.endIndex || '10', 10) || 10);
  const confirm = /^(1|true|yes|y|on)$/i.test(String(args.confirm || ''));
  const autoFallbackArg = args.autoFallback ?? args.autofallback ?? 'yes';
  const shrinkDirectionArg = args.shrinkDirection ?? args.shrinkdirection ?? '';
  const minChunkDaysArg = args.minChunkDays ?? args.minchunkdays ?? '1';
  const maxSpanDaysArg = args.maxSpanDays ?? args.maxspandays ?? '92';
  const autoFallback = !/^(0|false|no|n|off|manual)$/i.test(String(autoFallbackArg));
  const shrinkDirection = /^(latest|end|backward)$/i.test(String(shrinkDirectionArg)) ? 'latest' : 'earliest';
  const minChunkDays = Math.max(1, parseInt(minChunkDaysArg, 10) || 1);
  const maxSpanDays = Math.max(minChunkDays, Math.min(92, parseInt(maxSpanDaysArg, 10) || 92));
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

  const parseYmd = (value) => {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(value || '').trim());
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (Number.isNaN(date.getTime())) return null;
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
    return date;
  };

  const formatYmd = (date) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    const y = date.getUTCFullYear();
    const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  };

  const addDays = (date, delta) => {
    const next = new Date(date.getTime());
    next.setUTCDate(next.getUTCDate() + delta);
    return next;
  };

  const diffDays = (a, b) => {
    const start = a instanceof Date ? a : parseYmd(a);
    const end = b instanceof Date ? b : parseYmd(b);
    if (!start || !end) return null;
    return Math.floor((end - start) / 86400000) + 1;
  };

  const cmpYmd = (a, b) => {
    const left = parseYmd(a);
    const right = parseYmd(b);
    if (!left || !right) return null;
    return left.getTime() - right.getTime();
  };

  const mkRange = (beginDate, endDate) => ({beginDate, endDate, spanDays: diffDays(beginDate, endDate)});

  const clampKeepDays = (days, spanDays) => {
    if (!Number.isFinite(spanDays) || spanDays <= 0) return minChunkDays;
    if (spanDays <= minChunkDays) return spanDays;
    let keepDays = Math.floor(days);
    if (!Number.isFinite(keepDays) || keepDays <= 0) keepDays = minChunkDays;
    keepDays = Math.max(minChunkDays, Math.min(spanDays, keepDays));
    if (keepDays < spanDays) {
      keepDays = Math.max(minChunkDays, Math.floor(keepDays / minChunkDays) * minChunkDays);
      if (keepDays >= spanDays) keepDays = spanDays - minChunkDays;
      if (keepDays < minChunkDays) keepDays = minChunkDays;
    }
    return Math.min(spanDays, keepDays);
  };

  const keepRange = (beginDate, endDate, keepDays) => {
    const start = parseYmd(beginDate);
    const end = parseYmd(endDate);
    const spanDays = diffDays(start, end);
    if (!start || !end || !spanDays) return null;
    const kept = clampKeepDays(keepDays, spanDays);
    if (kept >= spanDays) return mkRange(beginDate, endDate);
    if (shrinkDirection === 'latest') {
      return mkRange(formatYmd(addDays(end, -(kept - 1))), endDate);
    }
    return mkRange(beginDate, formatYmd(addDays(start, kept - 1)));
  };

  const splitRange = (beginDate, endDate, chunkDays) => {
    const start = parseYmd(beginDate);
    const end = parseYmd(endDate);
    const ranges = [];
    if (!start || !end) return ranges;
    if (shrinkDirection === 'latest') {
      let cursorEnd = end;
      while (cursorEnd.getTime() >= start.getTime()) {
        let cursorStart = addDays(cursorEnd, -(chunkDays - 1));
        if (cursorStart.getTime() < start.getTime()) cursorStart = new Date(start.getTime());
        ranges.push(mkRange(formatYmd(cursorStart), formatYmd(cursorEnd)));
        cursorEnd = addDays(cursorStart, -1);
      }
      return ranges;
    }
    let cursorStart = start;
    while (cursorStart.getTime() <= end.getTime()) {
      let cursorEnd = addDays(cursorStart, chunkDays - 1);
      if (cursorEnd.getTime() > end.getTime()) cursorEnd = new Date(end.getTime());
      ranges.push(mkRange(formatYmd(cursorStart), formatYmd(cursorEnd)));
      cursorStart = addDays(cursorEnd, 1);
    }
    return ranges;
  };

  const quotaSummary = (stats, size) => {
    const cartFileCount = Number(stats?.cartFileCount || stats?.subFileCount || stats?.fileCount || stats?.shopcount || 0);
    const cartSizeBytes = Number(size?.sizeOfShop || stats?.subFileSize || stats?.sizeOfShop || 0);
    const orderedSizeBytes = Number(size?.sizeOfOrd || 0);
    const totalOrdAndShopBytes = Number(size?.sizeOfOrdAndShop || 0);
    const remainDmzFileSizeBytes = stats?.remainDmzFileSize != null ? Number(stats.remainDmzFileSize) : null;
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
      maxFileDownloadCount: size?.maxfiledownloadcount != null ? Number(size.maxfiledownloadcount) : null,
      remainDmzFileSizeBytes,
      remainDmzFileSizeHuman: remainDmzFileSizeBytes != null ? formatBytes(remainDmzFileSizeBytes) : null,
      fitsDailyVolumeLimit,
      overflowBytes,
      overflowHuman: overflowBytes != null ? formatBytes(overflowBytes) : null,
      retainRatio
    };
  };

  const rangeSuggestion = (beginDate, endDate, retainRatio) => {
    const spanDays = diffDays(beginDate, endDate);
    if (!spanDays || !Number.isFinite(retainRatio) || retainRatio <= 0) return null;
    const fitted = keepRange(beginDate, endDate, Math.floor(spanDays * retainRatio));
    if (!fitted) return null;
    return {
      policy: shrinkDirection === 'latest' ? 'keep-latest-window' : 'keep-earliest-window',
      keepDays: fitted.spanDays,
      suggestedBeginDate: fitted.beginDate,
      suggestedEndDate: fitted.endDate
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

  async function fetchJsonWithRetry(url, attempts = 3) {
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const resp = await apiFetch(url);
        if (!resp.ok) {
          return {ok: false, status: resp.status, data: null};
        }
        const data = await resp.json().catch(() => null);
        if (!data) {
          lastError = new Error('Invalid JSON response');
        } else {
          return {ok: true, status: resp.status, data};
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

  async function getCartQuota() {
    try {
      const statsResp = await fetchJsonWithRetry('/DataPortal/v1/data/cart/substats');
      const sizeResp = await fetchJsonWithRetry('/DataPortal/v1/data/cart/subsize');
      if (!statsResp.ok || !sizeResp.ok) return null;
      const statsData = statsResp.data;
      const sizeData = sizeResp.data;
      if (!statsData || !sizeData || statsData.status !== 1 || sizeData.status !== 1) return null;
      return {
        stats: statsData.resource || {},
        size: sizeData.resource || {},
        summary: quotaSummary(statsData.resource || {}, sizeData.resource || {})
      };
    } catch {
      return null;
    }
  }

  async function resolveProduct() {
    const product = (args.product || '').trim();
    const datatypeFromArg = (args.datatype || '').trim();
    const looksLikeFilenameCode = product.includes('_') || /\.nc$/i.test(product) || /YYYYMMDD/i.test(product);
    if (product && looksLikeFilenameCode) return product;
    const datatype = datatypeFromArg || (/^[A-Z0-9]{2,8}$/i.test(product) ? product : '');
    if (!datatype) throw new Error('Missing argument: product or datatype');
    const endpoint = `/DataPortal/v1/data/type/satellite/${encodeURIComponent(satellite)}/instrument/${encodeURIComponent(instrument)}/datatype/${encodeURIComponent(datatype)}/areatype/${encodeURIComponent(areatype)}/product`;
    const resp = await apiFetch(endpoint);
    if (!resp.ok) throw new Error('Product lookup HTTP ' + resp.status);
    const data = await resp.json().catch(() => null);
    if (!data || data.status !== 1 || !Array.isArray(data.resource) || !data.resource.length) {
      throw new Error(data?.message || 'No product found');
    }
    return data.resource[0].filenamecode;
  }

  function basePayload(productID, range) {
    return {
      productID,
      txtBeginDate: range.beginDate,
      txtBeginTime: beginTime,
      txtEndDate: range.endDate,
      txtEndTime: endTime,
      east_CoordValue: '180.0',
      west_CoordValue: '-180.0',
      north_CoordValue: '90.0',
      south_CoordValue: '-90.0',
      cbAllArea: 'on',
      cbGHIArea: 'on',
      converStatus: '',
      rdbIsEvery: '',
      beginIndex,
      endIndex,
      where: '',
      timeSelection,
      periodTime: '',
      daynight: ''
    };
  }

  function searchParams(payload, includeFileMeta) {
    const params = new URLSearchParams();
    Object.entries(payload).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      if (!includeFileMeta && (key === 'filecount' || key === 'filesize' || key === 'source')) return;
      params.set(key, String(value));
    });
    return params;
  }

  function pickNames(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => (
      row?.ARCHIVENAME || row?.archiveName || row?.FILENAME || row?.filename || row?.fileName || row?.name || row?.FILE_NAME || null
    )).filter(Boolean);
  }

  function chunkError(error, extra = {}) {
    return {
      error,
      productID: extra.productID || null,
      beginDate: extra.beginDate || null,
      endDate: extra.endDate || null,
      spanDays: extra.spanDays || null,
      hint: extra.hint || null,
      phase: extra.phase || null,
      status: extra.status != null ? extra.status : null
    };
  }

  async function inspectChunk(productID, range) {
    const payload = basePayload(productID, range);
    const resp = await apiFetch('/DataPortal/v1/data/selection/file/subcount?' + searchParams(payload, false).toString());
    if (!resp.ok) {
      return chunkError('HTTP ' + resp.status, {
        productID,
        beginDate: range.beginDate,
        endDate: range.endDate,
        spanDays: range.spanDays,
        phase: 'count',
        hint: resp.status === 401 || resp.status === 403 ? 'Please log in to the NSMC DataPortal first' : 'Search count failed'
      });
    }
    const data = await resp.json().catch(() => null);
    if (!data) {
      return chunkError('Invalid JSON response from subcount', {
        productID,
        beginDate: range.beginDate,
        endDate: range.endDate,
        spanDays: range.spanDays,
        phase: 'count'
      });
    }
    if (data.status !== 1) {
      return chunkError(data.message || ('API status ' + data.status), {
        productID,
        beginDate: range.beginDate,
        endDate: range.endDate,
        spanDays: range.spanDays,
        phase: 'count',
        status: data.status
      });
    }
    const filecount = Number(data.resource?.FILECOUNT || 0);
    const filesize = Number(data.resource?.FILESIZE || 0);
    return {
      productID,
      range: {...range},
      payload,
      filecount,
      filesize,
      filesize_human: formatBytes(filesize)
    };
  }

  async function detailChunk(inspected) {
    const payload = {
      ...inspected.payload,
      filecount: inspected.filecount,
      filesize: inspected.filesize,
      source: 0
    };
    const params = searchParams(payload, true).toString();

    const recordResp = await apiFetch('/DataPortal/v1/data/selection/subfilesearchrecord?' + params);
    if (!recordResp.ok) {
      return chunkError('Search record HTTP ' + recordResp.status, {
        productID: inspected.productID,
        beginDate: inspected.range.beginDate,
        endDate: inspected.range.endDate,
        spanDays: inspected.range.spanDays,
        phase: 'record'
      });
    }
    const recordData = await recordResp.json().catch(() => null);
    if (!recordData) {
      return chunkError('Invalid JSON response from subfilesearchrecord', {
        productID: inspected.productID,
        beginDate: inspected.range.beginDate,
        endDate: inspected.range.endDate,
        spanDays: inspected.range.spanDays,
        phase: 'record'
      });
    }
    if (recordData.status !== 1) {
      return chunkError(recordData.message || ('API status ' + recordData.status), {
        productID: inspected.productID,
        beginDate: inspected.range.beginDate,
        endDate: inspected.range.endDate,
        spanDays: inspected.range.spanDays,
        phase: 'record',
        status: recordData.status
      });
    }

    const fileResp = await apiFetch('/DataPortal/v1/data/selection/subfile?' + params);
    if (!fileResp.ok) {
      return chunkError('File list HTTP ' + fileResp.status, {
        productID: inspected.productID,
        beginDate: inspected.range.beginDate,
        endDate: inspected.range.endDate,
        spanDays: inspected.range.spanDays,
        phase: 'file'
      });
    }
    const fileData = await fileResp.json().catch(() => null);
    if (!fileData) {
      return chunkError('Invalid JSON response from subfile', {
        productID: inspected.productID,
        beginDate: inspected.range.beginDate,
        endDate: inspected.range.endDate,
        spanDays: inspected.range.spanDays,
        phase: 'file'
      });
    }
    if (fileData.status !== 1) {
      return chunkError(fileData.message || ('API status ' + fileData.status), {
        productID: inspected.productID,
        beginDate: inspected.range.beginDate,
        endDate: inspected.range.endDate,
        spanDays: inspected.range.spanDays,
        phase: 'file',
        status: fileData.status
      });
    }

    const records = Array.isArray(recordData.resource) ? recordData.resource : [];
    const pageFileNames = pickNames(fileData.resource);
    return {
      payload,
      records,
      pageFileNames,
      preview: {
        productID: inspected.productID,
        beginDate: inspected.range.beginDate,
        endDate: inspected.range.endDate,
        beginTime,
        endTime,
        timeSelection,
        filecount: inspected.filecount,
        filesize_bytes: inspected.filesize,
        filesize_human: inspected.filesize_human,
        records,
        pageFileNamesSample: pageFileNames.slice(0, 5),
        pageFileNameCount: pageFileNames.length
      }
    };
  }

  async function previewChunk(inspected) {
    const details = await detailChunk(inspected);
    if (details.error) return details;
    return {
      preview: true,
      ...details.preview,
      hint: 'Re-run with --confirm yes to add this range to the cart'
    };
  }

  async function addChunk(inspected) {
    const details = await detailChunk(inspected);
    if (details.error) return details;
    const addResp = await apiFetch('/DataPortal/v1/data/cart/suboption', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        ...details.payload,
        intoFlag: true,
        subFileSearchReaords: JSON.stringify(details.records),
        pageFileNames: details.pageFileNames
      })
    });
    if (!addResp.ok) return {error: 'cart/suboption HTTP ' + addResp.status, ...details.preview};
    const addData = await addResp.json().catch(() => null);
    if (!addData) return {error: 'Invalid JSON response from cart/suboption', ...details.preview};
    if (addData.status !== 1) {
      return {
        error: addData.message || ('API status ' + addData.status),
        status: addData.status,
        ...details.preview
      };
    }
    const statsResp = await apiFetch('/DataPortal/v1/data/cart/substats').catch(() => null);
    const statsData = statsResp ? await statsResp.json().catch(() => null) : null;
    return {
      preview: false,
      ...details.preview,
      added: true,
      response: addData,
      cartStats: statsData?.status === 1 ? statsData.resource : null
    };
  }

  async function fitChunk(productID, originalRange, remainBytes) {
    if (!(remainBytes > 0)) {
      return {
        fitted: null,
        remainingRanges: [{...originalRange, reason: 'quota-exhausted'}],
        rangeSuggestion: null
      };
    }

    let candidate = {...originalRange};
    let inspected = await inspectChunk(productID, candidate);
    if (inspected.error) return inspected;

    while (inspected.filesize > remainBytes) {
      if (candidate.spanDays <= minChunkDays) {
        return {
          fitted: null,
          remainingRanges: [{...originalRange, reason: 'quota-too-small'}],
          rangeSuggestion: rangeSuggestion(originalRange.beginDate, originalRange.endDate, remainBytes / inspected.filesize)
        };
      }
      let keepDays = clampKeepDays(Math.floor(candidate.spanDays * (remainBytes / inspected.filesize)), candidate.spanDays);
      if (keepDays >= candidate.spanDays) keepDays = Math.max(minChunkDays, candidate.spanDays - minChunkDays);
      const nextCandidate = keepRange(candidate.beginDate, candidate.endDate, keepDays);
      if (!nextCandidate || (nextCandidate.beginDate === candidate.beginDate && nextCandidate.endDate === candidate.endDate)) {
        return {
          fitted: null,
          remainingRanges: [{...originalRange, reason: 'quota-too-small'}],
          rangeSuggestion: rangeSuggestion(originalRange.beginDate, originalRange.endDate, remainBytes / inspected.filesize)
        };
      }
      candidate = nextCandidate;
      inspected = await inspectChunk(productID, candidate);
      if (inspected.error) return inspected;
    }

    const remainingRanges = [];
    if (candidate.beginDate !== originalRange.beginDate || candidate.endDate !== originalRange.endDate) {
      if (shrinkDirection === 'latest') {
        const omittedEnd = formatYmd(addDays(parseYmd(candidate.beginDate), -1));
        if (omittedEnd && cmpYmd(originalRange.beginDate, omittedEnd) <= 0) {
          remainingRanges.push({...mkRange(originalRange.beginDate, omittedEnd), reason: 'quota-trimmed'});
        }
      } else {
        const omittedBegin = formatYmd(addDays(parseYmd(candidate.endDate), 1));
        if (omittedBegin && cmpYmd(omittedBegin, originalRange.endDate) <= 0) {
          remainingRanges.push({...mkRange(omittedBegin, originalRange.endDate), reason: 'quota-trimmed'});
        }
      }
    }
    return {
      fitted: inspected,
      remainingRanges,
      rangeSuggestion: {
        policy: shrinkDirection === 'latest' ? 'keep-latest-window' : 'keep-earliest-window',
        keepDays: candidate.spanDays,
        suggestedBeginDate: candidate.beginDate,
        suggestedEndDate: candidate.endDate
      }
    };
  }

  const fallback = (remainBytes, suggestion) => ({
    kind: 'cart-capacity',
    label: '购物车剩余额度不足，已自动缩短到可容纳的最大连续日期范围',
    shrinkDirection,
    minChunkDays,
    remainDmzFileSizeBytes: remainBytes,
    remainDmzFileSizeHuman: remainBytes != null ? formatBytes(remainBytes) : null,
    rangeSuggestion: suggestion || null
  });

  const sumChunks = (chunks) => {
    let filecount = 0;
    let filesize = 0;
    for (const chunk of chunks) {
      filecount += Number(chunk.filecount || 0);
      filesize += Number(chunk.filesize_bytes || 0);
    }
    return {filecount, filesize_bytes: filesize, filesize_human: formatBytes(filesize)};
  };

  if (!rawBeginDate) return {error: 'Missing argument: beginDate'};
  if (!rawEndDate) return {error: 'Missing argument: endDate'};

  const beginDate = formatYmd(parseYmd(rawBeginDate));
  const endDate = formatYmd(parseYmd(rawEndDate));
  if (!beginDate) return {error: 'Invalid beginDate', hint: 'Use a real calendar date like 2023-09-01'};
  if (!endDate) return {error: 'Invalid endDate', hint: 'Use a real calendar date like 2023-12-31'};
  if (cmpYmd(beginDate, endDate) > 0) return {error: 'beginDate is later than endDate'};

  try {
    const requestedRange = mkRange(beginDate, endDate);
    if (!autoFallback && requestedRange.spanDays > maxSpanDays) {
      return {
        error: `Requested range is larger than ${maxSpanDays} days`,
        hint: `Split the range into chunks no larger than about ${maxSpanDays} days before cart add`,
        spanDays: requestedRange.spanDays
      };
    }

    const productID = await resolveProduct();
    const plannedRanges = requestedRange.spanDays > maxSpanDays ? splitRange(beginDate, endDate, maxSpanDays) : [requestedRange];
    let quotaState = await getCartQuota();
    let remainBytes = quotaState?.summary?.remainDmzFileSizeBytes ?? null;

    if (plannedRanges.length === 1) {
      const inspected = await inspectChunk(productID, plannedRanges[0]);
      if (inspected.error) return inspected;

      if (autoFallback && remainBytes != null && inspected.filesize > remainBytes) {
        const fitted = await fitChunk(productID, plannedRanges[0], remainBytes);
        if (fitted.error) return fitted;
        if (!fitted.fitted) {
          return {
            error: 'Current cart quota cannot fit the requested range',
            productID,
            beginDate,
            endDate,
            beginTime,
            endTime,
            timeSelection,
            preview: !confirm,
            fallback: fallback(remainBytes, fitted.rangeSuggestion),
            remainingRanges: fitted.remainingRanges
          };
        }

        const adjusted = {beginDate: plannedRanges[0].beginDate, endDate: plannedRanges[0].endDate, spanDays: plannedRanges[0].spanDays};
        if (!confirm) {
          return {
            preview: true,
            autoFallback: true,
            productID,
            beginDate,
            endDate,
            beginTime,
            endTime,
            timeSelection,
            chunkPlan: {
              requestedSpanDays: requestedRange.spanDays,
              maxSpanDays,
              minChunkDays,
              shrinkDirection,
              plannedChunkCount: 1,
              processedChunkCount: 1
            },
            chunks: [{
              index: 1,
              beginDate: fitted.fitted.range.beginDate,
              endDate: fitted.fitted.range.endDate,
              spanDays: fitted.fitted.range.spanDays,
              filecount: fitted.fitted.filecount,
              filesize_bytes: fitted.fitted.filesize,
              filesize_human: fitted.fitted.filesize_human,
              adjusted
            }],
            totals: {
              filecount: fitted.fitted.filecount,
              filesize_bytes: fitted.fitted.filesize,
              filesize_human: fitted.fitted.filesize_human
            },
            partial: true,
            remainingRanges: fitted.remainingRanges,
            cartQuota: quotaState?.summary || null,
            fallback: fallback(remainBytes, fitted.rangeSuggestion),
            hint: 'Re-run with --confirm yes to add the fitted range to the cart'
          };
        }

        const added = await addChunk(fitted.fitted);
        if (added.error) return added;
        quotaState = await getCartQuota();
        return {
          preview: false,
          autoFallback: true,
          productID,
          beginDate,
          endDate,
          beginTime,
          endTime,
          timeSelection,
          chunkPlan: {
            requestedSpanDays: requestedRange.spanDays,
            maxSpanDays,
            minChunkDays,
            shrinkDirection,
            plannedChunkCount: 1,
            processedChunkCount: 1
          },
          chunks: [{
            index: 1,
            beginDate: added.beginDate,
            endDate: added.endDate,
            spanDays: diffDays(added.beginDate, added.endDate),
            filecount: added.filecount,
            filesize_bytes: added.filesize_bytes,
            filesize_human: added.filesize_human,
            added: true,
            adjusted,
            response: added.response || null
          }],
          totals: {
            filecount: added.filecount,
            filesize_bytes: added.filesize_bytes,
            filesize_human: added.filesize_human
          },
          added: true,
          partial: true,
          remainingRanges: fitted.remainingRanges,
          cartQuota: quotaState?.summary || null,
          cartStats: quotaState?.stats || added.cartStats || null,
          fallback: fallback(remainBytes, fitted.rangeSuggestion)
        };
      }

      if (!confirm) return await previewChunk(inspected);
      return await addChunk(inspected);
    }

    const chunks = [];
    const remainingRanges = [];
    let fallbackInfo = null;

    for (let i = 0; i < plannedRanges.length; i++) {
      const planned = plannedRanges[i];
      let inspected = await inspectChunk(productID, planned);
      if (inspected.error) return inspected;

      let adjusted = null;
      if (autoFallback && remainBytes != null && inspected.filesize > remainBytes) {
        const fitted = await fitChunk(productID, planned, remainBytes);
        if (fitted.error) return fitted;
        fallbackInfo = fallback(remainBytes, fitted.rangeSuggestion);
        if (!fitted.fitted) {
          remainingRanges.push(...fitted.remainingRanges);
          for (let j = i + 1; j < plannedRanges.length; j++) remainingRanges.push({...plannedRanges[j], reason: 'quota-deferred'});
          break;
        }
        adjusted = {beginDate: planned.beginDate, endDate: planned.endDate, spanDays: planned.spanDays};
        inspected = fitted.fitted;
        remainingRanges.push(...fitted.remainingRanges);
        for (let j = i + 1; j < plannedRanges.length; j++) remainingRanges.push({...plannedRanges[j], reason: 'quota-deferred'});
      }

      if (!confirm) {
        chunks.push({
          index: chunks.length + 1,
          beginDate: inspected.range.beginDate,
          endDate: inspected.range.endDate,
          spanDays: inspected.range.spanDays,
          filecount: inspected.filecount,
          filesize_bytes: inspected.filesize,
          filesize_human: inspected.filesize_human,
          adjusted
        });
        if (remainBytes != null) remainBytes = Math.max(0, remainBytes - inspected.filesize);
        if (adjusted) break;
        continue;
      }

      const added = await addChunk(inspected);
      if (added.error) return added;
      chunks.push({
        index: chunks.length + 1,
        beginDate: added.beginDate,
        endDate: added.endDate,
        spanDays: diffDays(added.beginDate, added.endDate),
        filecount: added.filecount,
        filesize_bytes: added.filesize_bytes,
        filesize_human: added.filesize_human,
        added: true,
        adjusted,
        response: added.response || null
      });
      if (added.cartStats?.remainDmzFileSize != null) {
        remainBytes = Number(added.cartStats.remainDmzFileSize);
      } else if (remainBytes != null) {
        remainBytes = Math.max(0, remainBytes - inspected.filesize);
      }
      if (adjusted) break;
    }

    quotaState = await getCartQuota();
    return {
      preview: !confirm,
      autoFallback,
      productID,
      beginDate,
      endDate,
      beginTime,
      endTime,
      timeSelection,
      chunkPlan: {
        requestedSpanDays: requestedRange.spanDays,
        maxSpanDays,
        minChunkDays,
        shrinkDirection,
        plannedChunkCount: plannedRanges.length,
        processedChunkCount: chunks.length
      },
      chunks,
      totals: sumChunks(chunks),
      added: confirm,
      partial: remainingRanges.length > 0,
      remainingRanges: remainingRanges.length ? remainingRanges : [],
      cartQuota: quotaState?.summary || null,
      cartStats: quotaState?.stats || null,
      fallback: fallbackInfo,
      hint: confirm ? null : 'Re-run with --confirm yes to add these planned chunks to the cart'
    };
  } catch (error) {
    return {error: error.message || String(error)};
  }
}
