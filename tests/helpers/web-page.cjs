const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const web = path.join(__dirname, '../../web');
function page(t, app = false) {
  const dom = new JSDOM(fs.readFileSync(path.join(web, 'index.html'), 'utf8'), {
    url: 'http://127.0.0.1:4180/', runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const styles = window.document.createElement('style');
  styles.textContent = fs.readFileSync(path.join(web, 'styles.css'), 'utf8');
  window.document.head.appendChild(styles);
  for (const asset of ['vendor/marked.js', 'vendor/dompurify.js', 'markdown.js']) {
    window.eval(fs.readFileSync(path.join(web, asset), 'utf8'));
  }
  if (app) {
    window.setInterval = () => 1;
    window.scrollTo = () => {};
    window.fetch = async () => ({ ok: true, json: async () => ({ initialized: true, sealed: true, persistent: false }) });
    const source = fs.readFileSync(path.join(web, 'app.js'), 'utf8').replace('\ncheckStatus();\n', '\nwindow.initialStatusCheck = checkStatus();\n');
    window.eval(source + '\n' + fs.readFileSync(path.join(web, 'supplement.js'), 'utf8') + '\nwindow.stateForTest = state; showToast = () => {}; refreshAfterWrite = async () => {};');
    window.document.querySelector('#dataset-info-modal').showModal = () => {};
    window.document.querySelector('#dataset-info-modal').close = () => {};
  }
  return window;
}

module.exports = { page };
