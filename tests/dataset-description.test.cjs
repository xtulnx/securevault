const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');

test('Markdown renders headings, tables, lists and exact multiline SQL without treating it as HTML', (t) => {
  const window = page(t);
  const sql = 'SELECT id, name\nFROM users\nWHERE id < 10 AND name <> \'中文\';';
  const markdown = `## 查询说明\n\n**正式环境**\n\n- 数据用途\n- 数据来源\n\n| 字段 | 含义 |\n| --- | --- |\n| id | 编号 |\n\n\`\`\`sql\n${sql}\n\`\`\``;
  const container = window.document.createElement('div');
  container.innerHTML = window.renderMarkdown(markdown);
  assert.equal(container.querySelector('h2').textContent, '查询说明');
  assert.equal(container.querySelector('strong').textContent, '正式环境');
  assert.equal(container.querySelectorAll('li').length, 2);
  assert.ok(container.querySelector('table'));
  assert.equal(container.querySelector('pre code').textContent, sql + '\n');
  assert.ok(container.querySelector('code').classList.contains('language-sql'));
});

test('Markdown strips executable HTML, unsafe links, forms and remote embeds', (t) => {
  const window = page(t);
  const container = window.document.createElement('div');
  container.innerHTML = window.renderMarkdown('<script>alert(1)</script>\n<img src="https://example.test/tracker" onerror="alert(1)">\n<iframe src="https://example.test"></iframe>\n<form><input name="password"></form>\n\n[unsafe](javascript:alert%281%29)\n\n[safe](https://example.test/docs)\n\n<svg onload="alert(1)"></svg>');
  assert.equal(container.querySelector('script, img, iframe, form, input, svg'), null);
  for (const element of container.querySelectorAll('*')) {
    assert.ok(![...element.attributes].some((attribute) => attribute.name.startsWith('on')));
  }
  assert.ok(![...container.querySelectorAll('a')].some((link) => /javascript:/i.test(link.getAttribute('href') || '')));
  assert.equal(container.querySelector('a[href="https://example.test/docs"]').textContent, 'safe');
});

test('creating and editing datasets send unchanged long Markdown, preview it, and reset it for a new dataset', async (t) => {
  const window = page(t, true);
  await window.initialStatusCheck;
  window.stateForTest.unlocked = true;
  window.stateForTest.canManage = true;
  const document = window.document;
  const description = '  ## 数据说明\n\n```sql\nSELECT * FROM users;\n```\n' + '多行长文本\n'.repeat(2000);
  const dataset = { id: 'ds_test', category_path: '测试/说明', environment: null, description, fields: [], identity_fields: [], list_fields: [], record_count: 0, conflict_strategy: 'allow_mark' };
  window.stateForTest.datasets = [dataset];
  window.renderDatasetManager();
  document.querySelector('.dataset-edit-button').click();
  assert.equal(document.querySelector('#dataset-description').value, description);
  assert.equal(document.querySelector('#dataset-description-preview h2').textContent, '数据说明');
  const requests = [];
  window.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ category_path: dataset.category_path }) };
  };
  await window.createDataset();
  assert.equal(requests[0].options.method, 'PATCH');
  assert.equal(JSON.parse(requests[0].options.body).description, description);

  document.querySelector('#new-dataset-button').click();
  assert.equal(document.querySelector('#dataset-description').value, '');
  assert.equal(document.querySelector('#dataset-description-preview').textContent, '');
  document.querySelector('#dataset-category').value = '测试/新数据集';
  document.querySelector('#dataset-description').value = description;
  await window.createDataset();
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(JSON.parse(requests[1].options.body).description, description);

  window.openDatasetInfo('ds_test');
  assert.equal(document.querySelector('#dataset-info-content .markdown-content h2').textContent, '数据说明');
  assert.equal(document.querySelector('#dataset-info-content pre code').textContent, 'SELECT * FROM users;\n');
  document.querySelector('#dataset-description-preview-panel').open = true;
  document.querySelector('#dataset-description').value = '**已修改**';
  document.querySelector('#dataset-description').dispatchEvent(new window.Event('input'));
  assert.equal(document.querySelector('#dataset-description-preview strong').textContent, '已修改');
  await new Promise((resolve) => window.setTimeout(resolve, 0));
});
