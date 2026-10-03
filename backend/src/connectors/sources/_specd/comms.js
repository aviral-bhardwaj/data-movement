// Communication, meetings, forms & surveys specs.

module.exports = [
  {
    name: 'source-slack',
    displayName: 'Slack',
    description: 'Channels, users, messages, files and team metadata.',
    catalogSlug: 'slack-app', catalogName: 'Slack', category: 'Applications', icon: 'slack',
    baseUrl: 'https://slack.com/api',
    auth: { type: 'bearer' },
    config: [{ key: 'accessToken', title: 'Bot/User OAuth token', secret: true, required: true }],
    check: { path: '/auth.test' },
    resources: [
      { name: 'channels', path: '/conversations.list', params: { types: 'public_channel,private_channel', limit: 200 }, recordsPath: 'channels', primaryKey: 'id', cursorField: 'updated', filterClientSide: true, pagination: { type: 'cursor', cursorParam: 'cursor', cursorPath: 'response_metadata.next_cursor' } },
      { name: 'users', path: '/users.list', params: { limit: 200 }, recordsPath: 'members', primaryKey: 'id', cursorField: 'updated', filterClientSide: true, pagination: { type: 'cursor', cursorParam: 'cursor', cursorPath: 'response_metadata.next_cursor' } },
      { name: 'messages', path: '/conversations.history', params: { channel: '{channelId}' }, recordsPath: 'messages', primaryKey: 'ts', cursorField: 'ts', incrementalParam: 'oldest', pagination: { type: 'cursor', cursorParam: 'cursor', cursorPath: 'response_metadata.next_cursor' } },
      { name: 'files', path: '/files.list', recordsPath: 'files', primaryKey: 'id', cursorField: 'timestamp', filterClientSide: true, pagination: { type: 'cursor', cursorParam: 'cursor', cursorPath: 'paging.next_cursor' } },
      { name: 'team', path: '/team.info', recordsPath: 'team', primaryKey: 'id' },
    ],
    extraConfig: [{ key: 'channelId', title: 'Channel ID for message history' }],
  },

  {
    name: 'source-twilio',
    displayName: 'Twilio',
    description: 'Messages, calls, recordings, phone numbers and usage records.',
    catalogSlug: 'twilio', category: 'Applications', icon: 'twilio',
    baseUrl: 'https://api.twilio.com/2010-04-01',
    auth: { type: 'basic', username: '{accountSid}', password: '{authToken}' },
    config: [
      { key: 'accountSid', title: 'Account SID', required: true },
      { key: 'authToken', title: 'Auth token', secret: true, required: true },
    ],
    check: { path: '/Accounts/{accountSid}.json' },
    resources: [
      { name: 'messages', path: '/Accounts/{accountSid}/Messages.json', recordsPath: 'messages', primaryKey: 'sid', cursorField: 'date_updated', filterClientSide: true, pagination: { type: 'link', nextUrlPath: 'next_page_uri' } },
      { name: 'calls', path: '/Accounts/{accountSid}/Calls.json', recordsPath: 'calls', primaryKey: 'sid', cursorField: 'date_updated', filterClientSide: true, pagination: { type: 'link', nextUrlPath: 'next_page_uri' } },
      { name: 'recordings', path: '/Accounts/{accountSid}/Recordings.json', recordsPath: 'recordings', primaryKey: 'sid', pagination: { type: 'link', nextUrlPath: 'next_page_uri' } },
      { name: 'phone_numbers', path: '/Accounts/{accountSid}/IncomingPhoneNumbers.json', recordsPath: 'incoming_phone_numbers', primaryKey: 'sid', pagination: { type: 'link', nextUrlPath: 'next_page_uri' } },
      { name: 'usage_records', path: '/Accounts/{accountSid}/Usage/Records.json', recordsPath: 'usage_records', primaryKey: 'sid', pagination: { type: 'link', nextUrlPath: 'next_page_uri' } },
      { name: 'conferences', path: '/Accounts/{accountSid}/Conferences.json', recordsPath: 'conferences', primaryKey: 'sid', pagination: { type: 'link', nextUrlPath: 'next_page_uri' } },
      { name: 'notifications', path: '/Accounts/{accountSid}/Notifications.json', recordsPath: 'notifications', primaryKey: 'sid', pagination: { type: 'link', nextUrlPath: 'next_page_uri' } },
    ],
  },

  {
    name: 'source-calendly',
    displayName: 'Calendly',
    description: 'Event types, scheduled events, invitees and memberships.',
    catalogSlug: 'calendly', category: 'Applications', icon: 'calendly',
    baseUrl: 'https://api.calendly.com',
    auth: { type: 'bearer' },
    config: [
      { key: 'accessToken', title: 'Personal access token', secret: true, required: true },
      { key: 'organizationUri', title: 'Organization URI', required: true, help: 'https://api.calendly.com/organizations/XXXX' },
    ],
    check: { path: '/users/me' },
    resources: [
      { name: 'event_types', path: '/event_types', params: { organization: '{organizationUri}' }, recordsPath: 'collection', primaryKey: 'uri', pagination: { type: 'link', nextUrlPath: 'pagination.next_page' } },
      { name: 'scheduled_events', path: '/scheduled_events', params: { organization: '{organizationUri}' }, recordsPath: 'collection', primaryKey: 'uri', cursorField: 'updated_at', filterClientSide: true, pagination: { type: 'link', nextUrlPath: 'pagination.next_page' } },
      { name: 'organization_memberships', path: '/organization_memberships', params: { organization: '{organizationUri}' }, recordsPath: 'collection', primaryKey: 'uri', pagination: { type: 'link', nextUrlPath: 'pagination.next_page' } },
      { name: 'invitees', path: '/scheduled_events/{parentId}/invitees', recordsPath: 'collection', primaryKey: 'uri', child: { parent: 'scheduled_events', path: (p) => `/scheduled_events/${p.uri.split('/').pop()}/invitees` } },
    ],
  },

  {
    name: 'source-typeform',
    displayName: 'Typeform',
    description: 'Forms, responses, workspaces and themes.',
    catalogSlug: 'typeform', category: 'Applications', icon: 'typeform',
    baseUrl: 'https://api.typeform.com',
    auth: { type: 'bearer' },
    config: [{ key: 'accessToken', title: 'Personal access token', secret: true, required: true }],
    check: { path: '/me' },
    resources: [
      { name: 'forms', path: '/forms', recordsPath: 'items', primaryKey: 'id', pagination: { type: 'page', pageParam: 'page', limitParam: 'page_size', pageSize: 200 } },
      { name: 'responses', path: '/forms/{parentId}/responses', recordsPath: 'items', primaryKey: 'response_id', cursorField: 'submitted_at', filterClientSide: true, pagination: { type: 'page', pageParam: 'page', limitParam: 'page_size', pageSize: 1000 }, child: { parent: 'forms', path: (p) => `/forms/${p.id}/responses`, parentKey: 'id' } },
      { name: 'workspaces', path: '/workspaces', recordsPath: 'items', primaryKey: 'id', pagination: { type: 'page', pageParam: 'page', limitParam: 'page_size', pageSize: 200 } },
      { name: 'themes', path: '/themes', recordsPath: 'items', primaryKey: 'id', pagination: { type: 'page', pageParam: 'page', limitParam: 'page_size', pageSize: 200 } },
    ],
  },

  {
    name: 'source-surveymonkey',
    displayName: 'SurveyMonkey',
    description: 'Surveys, responses, collectors and contact lists.',
    catalogSlug: 'surveymonkey', category: 'Applications', icon: 'surveymonkey',
    baseUrl: 'https://api.surveymonkey.com/v3',
    auth: { type: 'bearer' },
    config: [{ key: 'accessToken', title: 'Access token', secret: true, required: true }],
    check: { path: '/users/me' },
    resources: [
      { name: 'surveys', path: '/surveys', recordsPath: 'data', primaryKey: 'id', cursorField: 'date_modified', incrementalParam: 'start_modified_at', pagination: { type: 'page', pageParam: 'page', limitParam: 'per_page', pageSize: 100 } },
      { name: 'responses', path: '/surveys/{parentId}/responses/bulk', recordsPath: 'data', primaryKey: 'id', cursorField: 'date_modified', incrementalParam: 'start_modified_at', pagination: { type: 'page', pageParam: 'page', limitParam: 'per_page', pageSize: 100 }, child: { parent: 'surveys', path: (p) => `/surveys/${p.id}/responses/bulk` } },
      { name: 'collectors', path: '/surveys/{parentId}/collectors', recordsPath: 'data', primaryKey: 'id', pagination: { type: 'page', pageParam: 'page', limitParam: 'per_page', pageSize: 100 }, child: { parent: 'surveys', path: (p) => `/surveys/${p.id}/collectors` } },
      { name: 'contact_lists', path: '/contact_lists', recordsPath: 'data', primaryKey: 'id', pagination: { type: 'page', pageParam: 'page', limitParam: 'per_page', pageSize: 100 } },
    ],
  },

  {
    name: 'source-zoom',
    displayName: 'Zoom',
    description: 'Users, meetings, webinars, recordings and phone data.',
    catalogSlug: 'zoom', category: 'Applications', icon: 'zoom',
    baseUrl: 'https://api.zoom.us/v2',
    auth: { type: 'bearer' },
    config: [{ key: 'accessToken', title: 'Server-to-Server OAuth token', secret: true, required: true }],
    check: { path: '/users/me' },
    resources: [
      { name: 'users', path: '/users', recordsPath: 'users', primaryKey: 'id', pagination: { type: 'offset', offsetParam: 'page_number', limitParam: 'page_size', pageSize: 300 } },
      { name: 'meetings', path: '/users/{parentId}/meetings', recordsPath: 'meetings', primaryKey: 'id', child: { parent: 'users', path: (p) => `/users/${p.id}/meetings` } },
      { name: 'webinars', path: '/users/{parentId}/webinars', recordsPath: 'webinars', primaryKey: 'id', child: { parent: 'users', path: (p) => `/users/${p.id}/webinars` } },
      { name: 'recordings', path: '/users/{parentId}/recordings', params: { from: '2000-01-01' }, recordsPath: 'meetings', primaryKey: 'uuid', child: { parent: 'users', path: (p) => `/users/${p.id}/recordings` } },
      { name: 'groups', path: '/groups', recordsPath: 'groups', primaryKey: 'id' },
    ],
  },

  {
    name: 'source-discord',
    displayName: 'Discord',
    description: 'Guilds, channels, members and messages (bot token).',
    catalogSlug: 'discord', category: 'Applications', icon: 'discord',
    baseUrl: 'https://discord.com/api/v10',
    auth: { type: 'raw_header', header: 'Authorization', value: 'Bot {accessToken}' },
    config: [{ key: 'accessToken', title: 'Bot token', secret: true, required: true }],
    check: { path: '/users/@me' },
    resources: [
      { name: 'guilds', path: '/users/@me/guilds', recordsPath: null, primaryKey: 'id' },
      { name: 'channels', path: '/guilds/{parentId}/channels', recordsPath: null, primaryKey: 'id', child: { parent: 'guilds', path: (p) => `/guilds/${p.id}/channels` } },
      { name: 'members', path: '/guilds/{parentId}/members', params: { limit: 1000 }, recordsPath: null, primaryKey: 'user.id', pagination: { type: 'cursor', cursorParam: 'after', cursorPath: null }, child: { parent: 'guilds', path: (p) => `/guilds/${p.id}/members` } },
    ],
  },

  {
    name: 'source-intercom-articles',
    displayName: 'Intercom Articles',
    description: 'Help center articles and collections (Intercom).',
    catalogSlug: null, category: 'Applications', icon: 'intercom',
    baseUrl: 'https://api.intercom.io',
    auth: { type: 'bearer' },
    headers: { 'Intercom-Version': '2.11' },
    config: [{ key: 'accessToken', title: 'Access token', secret: true, required: true }],
    check: { path: '/me' },
    resources: [
      { name: 'articles', path: '/articles', recordsPath: 'data', primaryKey: 'id', cursorField: 'updated_at', filterClientSide: true, pagination: { type: 'cursor', cursorParam: 'starting_after', cursorPath: 'pages.next.starting_after' } },
      { name: 'collections', path: '/help_center/collections', recordsPath: 'data', primaryKey: 'id' },
    ],
  },
];
