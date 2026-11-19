"""Builds dist/index.html — one self-contained file (chart library inlined)."""
from pathlib import Path

root = Path(__file__).parent
html = (root / "src/template.html").read_text()
parts = {
    "/*__LWC__*/": (root / "node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js").read_text(),
    "/*__CORE__*/": (root / "src/core.js").read_text(),
    "/*__DATA__*/": (root / "src/data.js").read_text(),
    "/*__APP__*/": (root / "src/app.js").read_text(),
}
for k, v in parts.items():
    html = html.replace(k, v.replace("</script>", "<\\/script>"))
(root / "dist").mkdir(exist_ok=True)
(root / "dist/index.html").write_text(html)
print("dist/index.html", len(html) // 1024, "KB")
