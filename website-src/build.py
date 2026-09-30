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


# Emerald → Indigo (Tailwind-Palette), für Klassen, Hex- und RGB-Werte
EMERALD_TO_INDIGO = {
    "#ecfdf5": "#eef2ff", "#d1fae5": "#e0e7ff", "#a7f3d0": "#c7d2fe", "#6ee7b7": "#a5b4fc",
    "#34d399": "#818cf8", "#10b981": "#6366f1", "#059669": "#4f46e5", "#047857": "#4338ca",
    "#065f46": "#3730a3", "#064e3b": "#312e81", "#022c22": "#1e1b4b",
}


def to_indigo(s):
    import re
    s = re.sub(r"\bemerald-", "indigo-", s)
    for em, ind in EMERALD_TO_INDIGO.items():
        s = re.sub(re.escape(em), ind, s, flags=re.I)
        a = tuple(int(em[i:i + 2], 16) for i in (1, 3, 5))
        b = tuple(int(ind[i:i + 2], 16) for i in (1, 3, 5))
        s = s.replace("rgb(%d %d %d" % a, "rgb(%d %d %d" % b)
        s = re.sub(r"(rgba?\()%d, ?%d, ?%d" % a, lambda m: m.group(1) + "%d,%d,%d" % b, s)
    return s


LOGO_MARK = (
    'Ji={light:{a:"#4f46e5",b:"#a5b4fc",c:"#fff",ink:"#1e293b"},dark:{a:"#818cf8",b:"#3730a3",c:"#0b1020",ink:"#f8fafc"}},'
    'ip=(e,t,l,a,n="cubic-bezier(.2,.8,.2,1)")=>({animation:`${e} ${t}s ${n} ${l}s both`,transformBox:"fill-box",transformOrigin:a});'
    'function cp({size:e=32,tone:t="light",animate:l=!1,className:a}){let n=Ji[t]??Ji.light,u=(i,c,s,o,v)=>l?ip(i,c,s,o,v):void 0;'
    'return(0,we.jsxs)("svg",{width:e,height:e,viewBox:"0 0 64 64",className:H("flex-none overflow-visible",a),"aria-hidden":"true",focusable:"false",children:['
    '(0,we.jsx)("path",{d:"M30 17H40a7 7 0 0 1 7 7V34",fill:"none",stroke:n.a,strokeWidth:"4",strokeLinecap:"round",style:u("swBar",.4,.7,"left center")}),'
    '(0,we.jsx)("path",{d:"M34 47H24a7 7 0 0 1-7-7V30",fill:"none",stroke:n.b,strokeWidth:"4",strokeLinecap:"round",style:u("swBar",.4,.9,"right center")}),'
    '(0,we.jsx)("rect",{x:"4",y:"4",width:"26",height:"26",rx:"8",fill:n.b,style:u("swCard",.5,0,"center")}),'
    '(0,we.jsx)("rect",{x:"34",y:"34",width:"26",height:"26",rx:"8",fill:n.a,style:u("swCard",.5,.3,"center")}),'
    '(0,we.jsx)("rect",{x:"10",y:"14",width:"14",height:"6",rx:"3",fill:n.a,style:u("swSlot",.4,1.1,"left center")}),'
    '(0,we.jsx)("rect",{x:"40",y:"44",width:"14",height:"6",rx:"3",fill:n.c,style:u("swSlot",.4,1.3,"left center")})]})}'
)


def rebrand(s):
    start = s.find("Ji={light:")
    end = s.find("function sp(", start)
    if start < 0 or end < 0 or s.count("Ji={light:") != 1:
        sys.exit("Logo-Komponente (Ji/cp) nicht gefunden")
    s = s[:start] + LOGO_MARK + s[end:]
    s = replace_once(s, 'children:"slotwise"})}function ru', 'children:"calensync"})}function ru', "Wortmarke")
    s = s.replace("Slotwise", "CalenSync")
    return to_indigo(s)


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

    # 6) Branding CalenSync: Sync-Symbol, Wortmarke, Produktname, Primärfarbe Indigo
    s = rebrand(s)

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
