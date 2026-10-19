const escapeTitle = value => String(value).replace(/[&<>"']/g, character => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
})[character]);

/* Body is the already-escaped HTML fragment produced by reportHtml in tools.mjs.
 * This document shell does not accept or sanitize arbitrary user HTML. */
export function reportDocument({title, body}) {
  if (typeof title !== 'string' || typeof body !== 'string') {
    throw new TypeError('Report title and rendered body must be strings');
  }
  const heading = escapeTitle(title);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>${heading}</title>
  <style>
    :root{color-scheme:light;--paper:#fffdf7;--ink:#292d27;--muted:#646c5d;--line:#d4d4c9;--brick:#9e4537;--surface:#f0eee5}
    *{box-sizing:border-box}
    html{background:#ebe9e0;-webkit-text-size-adjust:100%}
    body{margin:0;color:var(--ink);font:15px/1.95 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
    .report-document{width:min(100% - 48px,1020px);margin:40px auto 64px;padding:58px 68px 68px;background:var(--paper);border:1px solid #d4d2c7}
    .report-header{margin:0 0 38px;padding:0 0 29px;border-bottom:1px solid var(--line)}
    h1,h2{font-family:"Songti SC",STSong,"Noto Serif CJK SC",SimSun,serif;font-weight:650}
    h1{font-size:37px;line-height:1.48;letter-spacing:-.7px;margin:0;overflow-wrap:anywhere;text-wrap:balance}
    h2{font-size:25px;line-height:1.55;letter-spacing:-.3px;margin:39px 0 17px;break-after:avoid-page}
    h3{font-size:17px;line-height:1.7;font-weight:650;margin:29px 0 13px;break-after:avoid-page}
    h4{font-size:14px;line-height:1.8;font-weight:650;color:var(--brick);margin:24px 0 11px;break-after:avoid-page}
    .report-body>:first-child{margin-top:0}
    .report-body>p:first-child{font-size:16px;line-height:2;color:#3f4539;margin-bottom:25px}
    p{margin:15px 0;overflow-wrap:anywhere;orphans:3;widows:3}
    strong{font-weight:650;color:#30352c}
    ul,ol{margin:16px 0 22px;padding-left:1.55em}
    li{padding-left:.25em;margin:8px 0;overflow-wrap:anywhere}
    li::marker{color:#6c7561}
    a{color:var(--brick);text-decoration-thickness:1px;text-underline-offset:3px;overflow-wrap:anywhere}
    a:hover{color:#763427}
    a:focus-visible,.table-wrap:focus-visible{outline:2px solid var(--brick);outline-offset:4px}
    code{font:12.5px/1.8 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;background:#efede5;color:#4f5649;border-radius:2px;padding:2px 5px;overflow-wrap:anywhere}
    pre{margin:23px 0;padding:19px 21px;background:var(--surface);overflow:auto;max-width:100%;border:0;border-radius:2px;tab-size:2;break-inside:avoid-page}
    pre code{background:transparent;border:0;border-radius:0;padding:0;color:#434a3e;font-size:12px;line-height:1.85;white-space:pre;overflow-wrap:normal}
    .table-wrap{max-width:100%;overflow:auto;margin:23px 0 28px;scrollbar-width:thin;scrollbar-color:#b7bcad #efeee6}
    table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.8;text-align:left;font-variant-numeric:tabular-nums}
    th,td{min-width:110px;max-width:340px;padding:12px 14px;vertical-align:top;overflow-wrap:anywhere;border:0;border-bottom:1px solid #d4d4ca}
    th{background:#343a31;color:#fffdf2;font-size:12px;font-weight:600;border-bottom-color:#343a31;white-space:normal}
    th strong,th code{color:inherit;background:transparent}
    tbody tr:nth-child(even){background:#f4f3eb}
    tbody tr:last-child td{border-bottom-color:#c4c5b8}
    blockquote{margin:24px 0;padding:17px 20px;background:#efeee5;color:#626a58;border:0;border-radius:2px}
    blockquote>:first-child{margin-top:0}blockquote>:last-child{margin-bottom:0}
    hr{border:0;border-top:1px solid var(--line);margin:33px 0}
    @media(max-width:640px){
      .report-document{width:100%;margin:0;padding:32px 22px 42px;border:0}
      .report-header{margin-bottom:28px;padding-bottom:22px}
      h1{font-size:29px;line-height:1.5;letter-spacing:-.4px}h2{font-size:22px;margin-top:32px}h3{font-size:16px}
      body{font-size:14px;line-height:1.95}.report-body>p:first-child{font-size:15px}
      pre{padding:15px 16px}th,td{padding:10px 12px;min-width:105px}
    }
    @page{size:A4;margin:17mm 15mm 18mm}
    @media print{
      :root{--paper:#fff;--ink:#252a21;--muted:#666d5e}
      html,body{background:white}body{font-size:10pt;line-height:1.75}
      .report-document{width:auto;max-width:none;margin:0;padding:0;border:0;background:white}
      .report-header{margin-bottom:22pt;padding-bottom:17pt}h1{font-size:25pt;line-height:1.5}
      h2{font-size:17pt;margin:25pt 0 12pt}h3{font-size:12pt;margin:19pt 0 9pt}h4{font-size:10pt;margin:16pt 0 8pt}
      .report-body>p:first-child{font-size:10.8pt;line-height:1.85}p{margin:10pt 0}
      ul,ol{margin:11pt 0 15pt}li{margin:5pt 0}
      a{color:#6e3f2a;text-decoration:underline}a[href]::after{content:" (" attr(href) ")";font-size:8pt;color:#6f675b;overflow-wrap:anywhere}
      .table-wrap{overflow:visible;max-width:none;margin:16pt 0 20pt}
      table{width:100%;min-width:0;table-layout:fixed;font-size:8pt;line-height:1.65}
      th,td{min-width:0;max-width:none;padding:7pt 6pt;overflow-wrap:anywhere}
      th{background:#e5e5da;color:#343a2e;font-size:8pt;border-bottom:1px solid #b6bbab}
      thead{display:table-header-group}tfoot{display:table-footer-group}tr{break-inside:avoid-page}
      tbody tr:nth-child(even){background:#f6f6ef}
      pre{white-space:pre-wrap;overflow:visible;padding:12pt 14pt;break-inside:auto}
      pre code{white-space:pre-wrap;overflow-wrap:anywhere;font-size:8pt}
      blockquote{padding:12pt 14pt}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    }
  </style>
</head>
<body>
  <main class="report-document">
    <header class="report-header"><h1>${heading}</h1></header>
    <article class="report-body">${body}</article>
  </main>
</body>
</html>`;
}
