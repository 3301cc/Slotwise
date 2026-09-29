#!/usr/bin/env python3
"""
Baut slotwise-website-online/assets/site.js aus dem Original-Bundle plus den Quellen in website-src/.

    python3 website-src/build.py            # braucht esbuild (npx esbuild oder ESBUILD=/pfad/zu/esbuild)

Das Original (vendor/site.original.js) ist der Vite-Build der Website, zu dem keine Quellen im Repo liegen.
Jeder Eingriff unten sucht einen exakten Anker und bricht ab, wenn er fehlt – so fällt ein
verändertes Original sofort auf, statt still falsch gepatcht zu werden.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = ROOT / "slotwise-website-online" / "assets" / "site.js"
SOURCES = ["KiAgentPage.jsx", "SitePatches.jsx"]


def esbuild_bin():
    if os.environ.get("ESBUILD"):
        return [os.environ["ESBUILD"]]
    if shutil.which("esbuild"):
        return ["esbuild"]
    return ["npx", "--yes", "esbuild"]


def compile_jsx(name):
    cmd = esbuild_bin() + [
        str(HERE / name), "--loader:.jsx=jsx", "--jsx-factory=swH", "--jsx-fragment=swF",
        "--target=es2019", "--minify-whitespace", "--minify-syntax",
    ]
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout.strip()


def replace_once(src, old, new, label):
    n = src.count(old)
    if n != 1:
        sys.exit(f"Anker '{label}' {n}x gefunden (erwartet 1)")
    return src.replace(old, new)


def cut_function(src, name, end_marker, label):
    """Entfernt 'function name(...' bis ausschließlich end_marker."""
    start = src.find(f"function {name}(")
    if start < 0 or src.count(f"function {name}(") != 1:
        sys.exit(f"Funktion {label} nicht eindeutig gefunden")
    end = src.find(end_marker, start)
    if end < 0:
        sys.exit(f"Ende von {label} nicht gefunden")
    return src[:start] + src[end:]


def main():
    s = (HERE / "vendor" / "site.original.js").read_text(encoding="utf-8")

    # 1) Laufzeit-Konfiguration aus site-config.js (window.SLOTWISE_ENV) über die Build-Werte legen
    s = replace_once(
        s,
        'U={VITE_APP_URL:"https://app.slotwise.app",VITE_DEMO_BOOKING_PATH:"/book/nordlicht/demo-call",VITE_LOGIN_AUTO_REDIRECT:"1"}',
        'U=Object.assign({VITE_APP_URL:"https://app.slotwise.app",VITE_DEMO_BOOKING_PATH:"/book/nordlicht/demo-call",VITE_LOGIN_AUTO_REDIRECT:"0",VITE_APP_LIVE:"0"},typeof window<"u"&&window.SLOTWISE_ENV||{})',
        "Env-Objekt",
    )

    # 2) App-Links: solange die App nicht live ist → /anmelden bzw. Warteliste
    s = replace_once(
        s,
        'var tr=ou("/login"),ot=ou("/login?plan=trial"),_t=ou(rp)',
        'var tr=U.VITE_APP_LIVE==="1"?ou("/login"):"/anmelden",ot=U.VITE_APP_LIVE==="1"?ou("/login?plan=trial"):"#warteliste",_t=U.VITE_APP_LIVE==="1"?ou(rp):"#warteliste-demo"',
        "App-Links",
    )

    # 3) Alte Komponenten entfernen (Ersatz kommt aus SitePatches.jsx)
    s = cut_function(s, "ur", "S();var Yh={version:", "ur (Demo-Widget)")
    s = cut_function(s, "dr", "S();var x=N(O(),1),fl=U", "dr (/anmelden)")
    s = cut_function(s, "nr", "S();S();S();var cl=N(O(),1)", "nr (Layout)")
    s = cut_function(s, "$h", "function Ih(){", "$h (Datenschutz)")

    # 4) KI-Agent-Seite ersetzen und Ergänzungen dahinter einsetzen
    start = s.find("function fr(){")
    end = s.find("S();var Xh=N(Rt(),1)", start)
    if start < 0 or end < 0 or not s[start:end].endswith("(0,w.jsx)(vu,{})]})}"):
        sys.exit("KI-Agent-Seite (fr) nicht gefunden")
    s = s[:start] + ";".join(compile_jsx(n) for n in SOURCES) + ";" + s[end:]

    # 5) Texte
    s = replace_once(
        s,
        'intro:"Slotwise speichert und verarbeitet alle Buchungsdaten in Rechenzentren in Frankfurt am Main. Slotwise selbst \\xFCbermittelt keine personenbezogenen Daten in L\\xE4nder au\\xDFerhalb der EU."',
        'intro:"Die Slotwise-Plattform speichert und verarbeitet alle Buchungsdaten in Rechenzentren in Frankfurt am Main und \\xFCbermittelt selbst keine personenbezogenen Daten in L\\xE4nder au\\xDFerhalb der EU. F\\xFCr das Hosting dieser Website gilt der Abschnitt \\u201EHosting dieser Website (Vercel)\\u201C."',
        "Datenschutz-Intro",
    )
    s = replace_once(
        s,
        '"Unternehmensangaben fehlen noch: ",(0,x.jsx)("code",{className:"rounded bg-white px-1",children:"VITE_COMPANY_*"})," in ",(0,x.jsx)("code",{className:"rounded bg-white px-1",children:"apps/site/.env"})," setzen."',
        '"Anbieterangaben werden vor dem Livegang erg\\xE4nzt (",(0,x.jsx)("code",{className:"rounded bg-white px-1",children:"VITE_COMPANY_*"})," in ",(0,x.jsx)("code",{className:"rounded bg-white px-1",children:"site-config.js"}),")."',
        "Firmendaten-Hinweis",
    )

    OUT.write_text(s, encoding="utf-8")
    subprocess.run(["node", "--check", str(OUT)], check=True)
    print(f"ok: {OUT.relative_to(ROOT)} ({len(s):,} Bytes)")
    build_dashboard_css()


def build_dashboard_css():
    """dashboard/dashboard.css aus website-src/dashboard/ mit der Tailwind-CLI (TAILWINDCSS=/pfad, sonst npx)."""
    src = HERE / "dashboard"
    out = ROOT / "slotwise-website-online" / "dashboard" / "dashboard.css"
    tw = [os.environ["TAILWINDCSS"]] if os.environ.get("TAILWINDCSS") else (["tailwindcss"] if shutil.which("tailwindcss") else ["npx", "--yes", "tailwindcss@3"])
    subprocess.run(tw + ["-c", "tailwind.config.js", "-i", "dashboard.src.css", "-o", str(out), "--minify"], cwd=src, check=True, capture_output=True)
    print(f"ok: {out.relative_to(ROOT)} ({out.stat().st_size:,} Bytes)")


if __name__ == "__main__":
    main()
