const browser = chrome;
const SPECIAL_CHARS = '^$&+?.()|{}[]/'.split('');
const MAX_PROFILES_IN_CLOUD = 50;
let currentProfile;
let tabUrls = {};

/**
 * Check whether the current request url pass the given list of filters.
 */
function passFilters_(url, type, filters) {
  if (!filters) {
    return true;
  }
  var allowUrls = false;
  var hasUrlFilters = false;
  var allowTypes = false;
  var hasResourceTypeFilters = false;
  angular.forEach(filters, function(filter) {
    if (filter.enabled) {
      switch (filter.type) {
        case 'urls':
          hasUrlFilters = true;
          if (url.search(filter.urlPattern) == 0) {
            allowUrls = true;
          }
          break;
        case 'types':
          hasResourceTypeFilters = true;
          if (filter.resourceType.indexOf(type) >= 0) {
            allowTypes = true;
          }
          break;
      }
    }
  });
  return (!hasUrlFilters || allowUrls)
      && (!hasResourceTypeFilters || allowTypes);
};

function loadSelectedProfile_() {
  var appendMode = false;
  var headers = [];
  var respHeaders = [];
  var filters = [];
  if (localStorage.profiles) {
    var profiles = angular.fromJson(localStorage.profiles);
    if (!localStorage.selectedProfile) {
      localStorage.selectedProfile = 0;
    }
    var selectedProfile = profiles[localStorage.selectedProfile];

    function filterEnabledHeaders_(headers) {
      var output = [];
      angular.forEach(headers, function(header) {
        // Overrides the header if it is enabled and its name is not empty.
        if (header.enabled && header.name) {
          output.push({name: header.name, value: header.value});
        }
      });
      return output;
    };
    angular.forEach(selectedProfile.filters, function(filter) {
      if (filter.urlPattern) {
        var urlPattern = filter.urlPattern;
        var joiner = [];
        for (var i = 0; i < urlPattern.length; ++i) {
          var c = urlPattern.charAt(i);
          if (SPECIAL_CHARS.indexOf(c) >= 0) {
            c = '\\' + c;
          } else if (c == '\\') {
            c = '\\\\';
          } else if (c == '*') {
            c = '.*';
          }
          joiner.push(c);
        }
        filter.urlPattern = joiner.join('');
      }
      filters.push(filter);
    });
    appendMode = selectedProfile.appendMode;
    headers = filterEnabledHeaders_(selectedProfile.headers);
    respHeaders = filterEnabledHeaders_(selectedProfile.respHeaders);
  }
  return {
      appendMode: appendMode,
      headers: headers,
      respHeaders: respHeaders,
      filters: filters
  };
};

function modifyHeader(source, dest) {
  if (!source.length) {
    return;
  }
  // Create an index map so that we can more efficiently override
  // existing header.
  var indexMap = {};
  angular.forEach(dest, function(header, index) {
    indexMap[angular.lowercase(header.name)] = index;
  });
  angular.forEach(source, function(header) {
    var index = indexMap[angular.lowercase(header.name)];
    if (index !== undefined) {
      if (!currentProfile.appendMode) {
        dest[index].value = header.value;
      } else if (currentProfile.appendMode == 'comma') {
        if (dest[index].value) {
          dest[index].value += ',';
        }
        dest[index].value += header.value;
      } else {
        dest[index].value += header.value;
      }
    } else {
      dest.push({name: header.name, value: header.value});
      indexMap[angular.lowercase(header.name)] = dest.length - 1;
    }
  });
};

function modifyRequestHeaderHandler_(details) {
  if (localStorage.isPaused) {
    return {};
  }
  if (details.type == 'main_frame' && details.url && details.tabId) {
    tabUrls[details.tabId] = details.url;
    localStorage.activeTabId = details.tabId;
    browser.tabs.get(details.tabId, onTabUpdated);
  }
  currentProfile = loadSelectedProfile_();
  if (!localStorage.lockedTabId
      || localStorage.lockedTabId == details.tabId) {
    if (currentProfile
        && passFilters_(details.url, details.type, currentProfile.filters)) {
      modifyHeader(currentProfile.headers, details.requestHeaders);
    }
  }
  return {requestHeaders: details.requestHeaders};
};

function modifyResponseHeaderHandler_(details) {
  if (localStorage.isPaused) {
    return {};
  }
  var responseHeaders = angular.copy(details.responseHeaders);
  if (!localStorage.lockedTabId
      || localStorage.lockedTabId == details.tabId) {
    if (currentProfile
        && passFilters_(details.url, details.type, currentProfile.filters)) {
      modifyHeader(currentProfile.respHeaders, responseHeaders);
    }
  }
  if (!angular.equals(responseHeaders, details.responseHeaders)) {
    return {responseHeaders: responseHeaders};
  }
};

browser.webRequest.onBeforeSendHeaders.addListener(
  modifyRequestHeaderHandler_,
  {urls: ["<all_urls>"]},
  ['requestHeaders', 'blocking']
);

browser.webRequest.onHeadersReceived.addListener(
  modifyResponseHeaderHandler_,
  {urls: ["<all_urls>"]},
  ['responseHeaders', 'blocking']
);

function onTabUpdated(tab) {
  if (tab.active) {
    // Since we don't have access to the "tabs" permission, we may not have
    // access to the url property all the time. So, match it against the URL
    // found during request modification.
    let url = tab.url;
    if (url) {
      tabUrls[tab.id] = url;
    } else {
      url = tabUrls[tab.id];
    }
    localStorage.activeTabId = tab.id;

    // Only set the currentTabUrl property if the tab is active and the window
    // is in focus.
    browser.windows.get(tab.windowId, {}, (win) => {
      if (win.focused) {
        localStorage.currentTabUrl = url;
      }
    });
    if (!url) {
      return;
    }
    resetBadgeAndContextMenu();
  }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  onTabUpdated(tab);
});

browser.tabs.onActivated.addListener((activeInfo) => {
  browser.tabs.get(activeInfo.tabId, onTabUpdated);
});

browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId == browser.windows.WINDOW_ID_NONE) {
    return;
  }
  browser.windows.get(windowId, {populate: true}, (win) => {
    for (let tab of win.tabs) {
      onTabUpdated(tab);
    }
  });
});

function saveStorageToCloud() {
  browser.storage.sync.get(null, (items) => {
      const keys = items ? Object.keys(items) : [];
      keys.sort();
      if (keys.length == 0 ||
          items[keys[keys.length - 1]] != localStorage.profiles) {
        const data = {};
        data[Date.now()] = localStorage.profiles;
        browser.storage.sync.set(data);
        localStorage.savedToCloud = true;
      }
      if (keys.length >= MAX_PROFILES_IN_CLOUD) {
        browser.storage.sync.remove(keys.slice(0, keys.length - MAX_PROFILES_IN_CLOUD));
      }
    });
}

function createContextMenu() {
  if (localStorage.isPaused) {
    browser.contextMenus.update(
      'pause',
      {
        title: 'Unpause ModHeader',
        contexts: ['browser_action'],
        onclick: () => {
          localStorage.removeItem('isPaused');
          resetBadgeAndContextMenu();
        }
      });
  } else {
    browser.contextMenus.update(
      'pause',
      {
        title: 'Pause ModHeader',
        contexts: ['browser_action'],
        onclick: () => {
          localStorage.isPaused = true;
          resetBadgeAndContextMenu();
        }
      });
  }
  if (localStorage.lockedTabId) {
    browser.contextMenus.update(
      'lock',
      {
        title: 'Unlock to all tabs',
        contexts: ['browser_action'],
        onclick: () => {
          localStorage.removeItem('lockedTabId');
          resetBadgeAndContextMenu();
        }
      });
  } else {
    browser.contextMenus.update(
      'lock',
      {
        title: 'Lock to this tab',
        contexts: ['browser_action'],
        onclick: () => {
          localStorage.lockedTabId = localStorage.activeTabId;
          resetBadgeAndContextMenu();
        }
      });
  }
}

function resetBadgeAndContextMenu() {
  if (localStorage.isPaused) {
    browser.browserAction.setIcon({path: 'icon_bw.png'});
    browser.browserAction.setBadgeText({text: '\u275A\u275A'});
    browser.browserAction.setBadgeBackgroundColor({color: '#666'});
  } else {
    currentProfile = loadSelectedProfile_();
    const numHeaders = (currentProfile.headers.length + currentProfile.respHeaders.length);
    if (numHeaders == 0) {
      browser.browserAction.setBadgeText({text: ''});
      browser.browserAction.setIcon({path: 'icon_bw.png'});
    } else if (localStorage.lockedTabId
        && localStorage.lockedTabId != localStorage.activeTabId) {
      browser.browserAction.setIcon({path: 'icon_bw.png'});
      browser.browserAction.setBadgeText({text: '\uD83D\uDD12'});
      browser.browserAction.setBadgeBackgroundColor({color: '#ff8e8e'});
    } else {
      browser.browserAction.setIcon({path: 'icon.png'});
      browser.browserAction.setBadgeText({text: numHeaders.toString()});
      browser.browserAction.setBadgeBackgroundColor({color: '#db4343'});
    }
  }
  createContextMenu();
}

function initializeStorage() {
  window.addEventListener('storage', function(e) {
    resetBadgeAndContextMenu();
    if (e.key == 'profiles') {
      saveStorageToCloud();
    }
  });

  // Async initialization.
  setTimeout(() => {
    if (localStorage.profiles && !localStorage.savedToCloud) {
      saveStorageToCloud();
    }

    if (!localStorage.profiles) {
      browser.storage.sync.get(null, (items) => {
        const keys = items ? Object.keys(items) : [];
        keys.sort();
        if (keys.length > 0) {
          localStorage.profiles = items[keys[keys.length - 1]];
          localStorage.savedToCloud = true;
        }
      });
    }
  }, 100);
}
browser.contextMenus.create({
  id: 'pause',
  title: 'Pause',
  contexts: ['browser_action'],
});
browser.contextMenus.create({
  id: 'lock',
  title: 'Lock',
  contexts: ['browser_action'],
});
initializeStorage();
resetBadgeAndContextMenu();
