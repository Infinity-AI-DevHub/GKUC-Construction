export const DEVELOPER_CREDIT='Developed by Infinity AI (Pvt) Ltd, Sri Lanka';
/** Mandatory credit is separate from configurable company footers. */
export function withDeveloperCredit(html,{everyPage=false}={}){
  if(/data-developer-credit="(?:end|every-page)"/.test(html))return html;
  const style=`<style data-developer-credit-style>.developer-credit{font:9px/1.4 Arial,Helvetica,sans-serif!important;color:#68778a!important;text-align:center!important;margin:12px 0 0!important;padding:6px 0 0!important;border-top:1px solid #e3e8ee;break-inside:avoid;page-break-inside:avoid}${everyPage?`@media print{.developer-credit{display:none!important}}@page{@bottom-center{content:"${DEVELOPER_CREDIT}";font:8px Arial;color:#69798d;vertical-align:bottom;padding-bottom:3mm}}`:''}</style>`;
  const credit=`<p class="developer-credit" data-developer-credit="${everyPage?'every-page':'end'}">${DEVELOPER_CREDIT}</p>`;
  const styled=html.replace('</head>',style+'</head>');
  if(styled.includes('<!-- developer-credit -->'))return styled.replace('<!-- developer-credit -->',credit);
  // Earlier issued HR letters are stored verbatim. Keep their added presentation
  // credit inside the full-page paper so it cannot create a second blank page.
  if(styled.includes('<article class="paper"')&&/<\/article>\s*<\/body>/.test(styled))return styled.replace(/<\/article>\s*<\/body>/,credit+'</article></body>');
  return styled.replace('</body>',credit+'</body>');
}
