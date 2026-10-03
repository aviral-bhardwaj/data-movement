// File storage, docs & collaboration specs.

module.exports = [
  {
    name: 'source-box',
    displayName: 'Box',
    description: 'Files, folders, users, groups and collaborations.',
    catalogSlug: 'box', category: 'Files', icon: 'box',
    baseUrl: 'https://api.box.com/2.0',
    auth: { type: 'bearer' },
    config: [{ key: 'accessToken', title: 'Developer/OAuth token', secret: true, required: true }],
    check: { path: '/users/me' },
    resources: [
      { name: 'users', path: '/users', recordsPath: 'entries', primaryKey: 'id', pagination: { type: 'offset', offsetParam: 'offset', limitParam: 'limit', pageSize: 1000, totalPath: 'total_count' } },
      { name: 'groups', path: '/groups', recordsPath: 'entries', primaryKey: 'id', pagination: { type: 'offset', offsetParam: 'offset', limitParam: 'limit', pageSize: 1000, totalPath: 'total_count' } },
      { name: 'folder_items', path: '/folders/{folderId}/items', recordsPath: 'entries', primaryKey: 'id', pagination: { type: 'cursor', cursorParam: 'marker', cursorPath: 'next_marker' } },
      { name: 'recent_items', path: '/recent_items', recordsPath: 'entries', primaryKey: 'id', cursorField: 'interacted_at', filterClientSide: true, pagination: { type: 'cursor', cursorParam: 'marker', cursorPath: 'next_marker' } },
      { name: 'collaborations', path: '/collaborations', recordsPath: 'entries', primaryKey: 'id' },
      { name: 'file_comments', path: '/files/{parentId}/comments', recordsPath: 'entries', primaryKey: 'id', child: { parent: 'folder_items', path: (p) => `/files/${p.id}/comments` } },
    ],
    extraConfig: [{ key: 'folderId', title: 'Root folder ID', default: '0' }],
  },

  {
    name: 'source-dropbox',
    displayName: 'Dropbox',
    description: 'Files, folders, team members and shared links.',
    catalogSlug: 'dropbox', category: 'Files', icon: 'dropbox',
    baseUrl: 'https://api.dropboxapi.com/2',
    auth: { type: 'bearer' },
    headers: { 'Content-Type': 'application/json' },
    config: [
      { key: 'accessToken', title: 'OAuth access token', secret: true, required: true },
      { key: 'path', title: 'Root path', default: '', help: 'Folder path to scan (empty = root)' },
    ],
    check: { path: '/users/get_current_account', method: 'POST' },
    resources: [
      {
        name: 'files', path: '/files/list_folder', method: 'POST',
        body: (cfg) => ({ path: cfg.path || '', recursive: true, limit: 2000, include_deleted: false }),
        recordsPath: 'entries', primaryKey: 'id', cursorField: 'server_modified', filterClientSide: true,
        pagination: { type: 'cursor', place: 'body', cursorParam: 'cursor', cursorPath: 'cursor', continuePath: '/files/list_folder/continue' },
        map: (x) => ({ ...x, _tag: x['.tag'] }),
      },
      {
        name: 'team_members', path: '/team/members/list', method: 'POST',
        body: { limit: 300 },
        recordsPath: 'members', primaryKey: 'profile.team_member_id',
        pagination: { type: 'cursor', place: 'body', cursorParam: 'cursor', cursorPath: 'cursor', continuePath: '/team/members/list/continue' },
      },
      {
        name: 'shared_links', path: '/sharing/list_shared_links', method: 'POST',
        body: {},
        recordsPath: 'links', primaryKey: 'id',
        pagination: { type: 'cursor', place: 'body', cursorParam: 'cursor', cursorPath: 'cursor' },
      },
    ],
  },

  {
    name: 'source-google-drive',
    displayName: 'Google Drive',
    description: 'Files, folders, permissions, comments and activity metadata.',
    catalogSlug: 'google-drive', category: 'Files', icon: 'gdrive',
    baseUrl: 'https://www.googleapis.com/drive/v3',
    auth: { type: 'bearer' },
    config: [
      { key: 'accessToken', title: 'OAuth access token', secret: true, required: true },
      { key: 'query', title: 'Search query', help: 'Drive query syntax, e.g. mimeType != "application/vnd.google-apps.folder"' },
    ],
    check: { path: '/about', params: { fields: 'user' } },
    resources: [
      { name: 'files', path: '/files', params: { fields: '*', pageSize: 1000, q: '{query}' }, recordsPath: 'files', primaryKey: 'id', cursorField: 'modifiedTime', filterClientSide: true, pagination: { type: 'cursor', cursorParam: 'pageToken', cursorPath: 'nextPageToken' } },
      { name: 'comments', path: '/files/{parentId}/comments', params: { fields: '*' }, recordsPath: 'comments', primaryKey: 'id', cursorField: 'modifiedTime', filterClientSide: true, pagination: { type: 'cursor', cursorParam: 'pageToken', cursorPath: 'nextPageToken' }, child: { parent: 'files', path: (p) => `/files/${p.id}/comments` } },
      { name: 'permissions', path: '/files/{parentId}/permissions', recordsPath: 'permissions', primaryKey: 'id', child: { parent: 'files', path: (p) => `/files/${p.id}/permissions` } },
      { name: 'revisions', path: '/files/{parentId}/revisions', recordsPath: 'revisions', primaryKey: 'id', cursorField: 'modifiedTime', filterClientSide: true, child: { parent: 'files', path: (p) => `/files/${p.id}/revisions` } },
    ],
  },

  {
    name: 'source-google-sheets',
    displayName: 'Google Sheets',
    description: 'Rows from configured sheets/ranges, flattened to records.',
    catalogSlug: 'google-sheets', category: 'Files', icon: 'gsheets',
    baseUrl: 'https://sheets.googleapis.com/v4',
    auth: { type: 'query', param: 'key' },
    config: [
      { key: 'apiKey', title: 'API key (or use OAuth token)', secret: true },
      { key: 'accessToken', title: 'OAuth access token', secret: true },
      { key: 'spreadsheetId', title: 'Spreadsheet ID', required: true },
      { key: 'ranges', title: 'Ranges (comma-separated)', required: true, help: 'e.g. Sheet1!A:Z, Sheet2!A1:D100' },
      { key: 'hasHeader', title: 'First row is header', type: 'boolean', default: true },
    ],
    check: { path: '/spreadsheets/{spreadsheetId}' },
    resources: (cfg) => String(cfg.ranges || '').split(',').map((t) => t.trim()).filter(Boolean).map((range, i) => {
      let header = null;
      const sheetName = range.split('!')[0].replace(/'/g, '');
      return {
        name: sheetName.toLowerCase().replace(/[^a-z0-9]+/g, '_') || `sheet_${i + 1}`,
        path: `/spreadsheets/{spreadsheetId}/values/${encodeURIComponent(range)}`,
        recordsPath: 'values',
        map: (row, idx) => {
          if (!Array.isArray(row)) return row;
          if (cfg.hasHeader !== false) {
            if (idx === 0) { header = row.map((h) => String(h).toLowerCase().replace(/[^a-z0-9]+/g, '_')); return null; }
            return Object.fromEntries(row.map((v, c) => [header?.[c] || `col_${c + 1}`, v]));
          }
          return Object.fromEntries(row.map((v, c) => [`col_${c + 1}`, v]));
        },
        _range: range,
      };
    }),
  },
];
