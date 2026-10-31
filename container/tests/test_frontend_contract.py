"""Cheap guards for the browser code, so a renamed element does not break a screen silently."""
import json
import re
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "static"
HTML = (STATIC / "templates" / "index.html").read_text()
JS_FILES = sorted((STATIC / "js").rglob("*.js"))


def html_ids():
    return set(re.findall(r'\bid="([\w-]+)"', HTML))


def test_every_element_the_javascript_looks_up_exists_in_the_page():
    wanted = {}
    for path in JS_FILES:
        for found in re.findall(r"""(?:\$|getElementById)\(\s*["']([\w-]+)["']\s*\)""", path.read_text()):
            wanted.setdefault(found, path.name)
    missing = {name: file for name, file in wanted.items() if name not in html_ids()}
    assert not missing, f"ids used in JavaScript but missing from index.html: {missing}"


def test_every_screen_has_its_container_in_the_page():
    dom = (STATIC / "js" / "ui" / "dom.js").read_text()
    views = re.search(r"const VIEWS = \[(.*?)\]", dom).group(1)
    for name in re.findall(r'"(\w+)"', views):
        assert f"{name}-view" in html_ids(), f"screen '{name}' has no #{name}-view in index.html"


def test_javascript_modules_import_files_that_exist():
    for path in JS_FILES:
        for target in re.findall(r"""from\s+["'](\.{1,2}/[^"']+)["']""", path.read_text()):
            assert (path.parent / target).resolve().is_file(), f"{path.name} imports missing file {target}"


def test_static_assets_in_the_page_exist():
    missing = [t for t in re.findall(r"filename='([^']+)'", HTML) if not (STATIC / t).is_file()]
    assert not missing, f"index.html references files that are not in the repo: {missing}"


def test_app_icons_in_the_manifest_exist():
    manifest = json.loads((STATIC / "manifest.webmanifest").read_text())
    missing = [i["src"] for i in manifest["icons"] if not (STATIC.parent / i["src"].lstrip("/")).is_file()]
    assert not missing, f"manifest.webmanifest references icons that are not in the repo: {missing}"