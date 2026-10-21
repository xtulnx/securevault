const guide = new URLSearchParams(location.search).get('guide');
const guideContent = document.getElementById('guide-content');
if (!['httpyac', 'raycast'].includes(guide)) guideContent.textContent = '请选择 httpyac 或 Raycast 接入说明。';
else fetch(`guides/${guide}.md`).then(async response => {
  if (!response.ok) throw new Error('说明加载失败，请刷新重试。');
  guideContent.innerHTML = renderMarkdown(await response.text());
  for (const link of guideContent.querySelectorAll('a')) {
    if (['securevault.mjs', 'example.http'].includes(link.getAttribute('href'))) link.href = `guides/${link.getAttribute('href')}`;
    if (/^https?:/.test(link.href) && link.origin !== location.origin) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  }
}).catch(error => { guideContent.textContent = error.message; });
