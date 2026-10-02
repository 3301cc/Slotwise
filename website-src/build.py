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
SOURCES = ["KiAgentPage.jsx", "SitePatches.jsx", "PraxenPage.jsx"]


def esbuild_bin():
    if os.environ.get("ESBUILD"):
        return [os.environ["ESBUILD"]]
    if shutil.which("esbuild"):
        return ["esbuild"]
    return ["npx", "--yes", "esbuild"]


TS_TRANSPILE = r"""
const ts = require("typescript");
const src = require("fs").readFileSync(process.argv[1], "utf8");
const out = ts.transpileModule(src, { compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: "swH", jsxFragmentFactory: "swF",
  target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None, removeComments: true } });
process.stdout.write(out.outputText);
"""


def typescript_available():
    if not shutil.which("node"):
        return False
    r = subprocess.run(["node", "-e", "require.resolve('typescript')"], capture_output=True, env=node_env())
    return r.returncode == 0


def node_env():
    env = dict(os.environ)
    root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True).stdout.strip() if shutil.which("npm") else ""
    if root:
        env["NODE_PATH"] = os.pathsep.join(p for p in (env.get("NODE_PATH"), root) if p)
    return env


def compile_jsx(name):
    # Ohne esbuild (z. B. kein npm-Zugriff): TypeScript-Compiler als Ersatz, falls global installiert
    if not os.environ.get("ESBUILD") and not shutil.which("esbuild") and typescript_available():
        cmd = ["node", "-e", TS_TRANSPILE, str(HERE / name)]
        return subprocess.run(cmd, check=True, capture_output=True, text=True, env=node_env()).stdout.strip()
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
    'function cp({size:e=32,tone:t="light",animate:l=!1,className:a}){let n=Ji[t]??Ji.light,u=(i,c,s,o)=>l?ip(i,c,s,o):void 0,'
    'd=(i,c)=>l?{strokeDasharray:100,animation:`csDraw ${i}s cubic-bezier(.6,0,.2,1) ${c}s both`}:void 0;'
    'return(0,we.jsxs)("svg",{width:e,height:e,viewBox:"0 0 64 64",className:H("flex-none overflow-visible",a),"aria-hidden":"true",focusable:"false",children:['
    '(0,we.jsx)("path",{d:"M30 17H40a7 7 0 0 1 7 7V34",fill:"none",stroke:n.a,strokeWidth:"4",strokeLinecap:"round",pathLength:"100",style:d(.45,.4)}),'
    '(0,we.jsx)("path",{d:"M34 47H24a7 7 0 0 1-7-7V30",fill:"none",stroke:n.b,strokeWidth:"4",strokeLinecap:"round",pathLength:"100",style:d(.45,.55)}),'
    '(0,we.jsx)("rect",{x:"4",y:"4",width:"26",height:"26",rx:"8",fill:n.b,style:u("csPop",.4,0,"center")}),'
    '(0,we.jsx)("rect",{x:"34",y:"34",width:"26",height:"26",rx:"8",fill:n.a,style:u("csPop",.4,.15,"center")}),'
    '(0,we.jsx)("rect",{x:"10",y:"14",width:"14",height:"6",rx:"3",fill:n.a,style:u("csSlot",.3,.9,"left center")}),'
    '(0,we.jsx)("rect",{x:"40",y:"44",width:"14",height:"6",rx:"3",fill:n.c,style:u("csSlot",.3,1,"left center")})]})}'
)


def rebrand(s):
    start = s.find("Ji={light:")
    end = s.find("function sp(", start)
    if start < 0 or end < 0 or s.count("Ji={light:") != 1:
        sys.exit("Logo-Komponente (Ji/cp) nicht gefunden")
    s = s[:start] + LOGO_MARK + s[end:]
    s = replace_once(s, 'children:"slotwise"})}function ru', 'children:"calensync"})}function ru', "Wortmarke")
    # Wortmarke und Abstand wie im animierten Logo (Plus Jakarta Sans 700, csWord)
    s = replace_once(s, 'className:H("font-display font-extrabold leading-none",a),style:{fontSize:e,letterSpacing:"-0.045em",color:n.ink,animation:l?"swWord .7s cubic-bezier(.2,.8,.2,1) .5s both"',
                     'className:H("font-display font-bold leading-none",a),style:{fontSize:e,letterSpacing:"-0.04em",color:n.ink,animation:l?"csWord .7s cubic-bezier(.2,.8,.2,1) .45s both"', "Wortmarke-Stil")
    s = replace_once(s, 'className:H("inline-flex items-center",n),style:{gap:t*.26}', 'className:H("cs-anim inline-flex items-center",n),style:{gap:t*.28}', "Logo-Abstand")
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

    # 4b) Startseite: Dashboard-Sektion zwischen Hero und Live-Feed (SwDashboardSection aus SitePatches.jsx)
    s = replace_once(
        s,
        'function cr(){return(0,fa.jsxs)(fa.Fragment,{children:[(0,fa.jsx)(ir,{}),(0,fa.jsx)(vu,{})]})}',
        'function cr(){return(0,fa.jsxs)(fa.Fragment,{children:[(0,fa.jsx)(ir,{}),(0,fa.jsx)(SwDashboardSection,{}),(0,fa.jsx)(vu,{})]})}',
        "Startseite (cr)",
    )

    # 4c) Hauptmenü: „Dashboard“ nach FAQ. /dashboard ist eine statische Seite außerhalb der SPA,
    #     daher ein normales <a> statt NavLink (If) – sonst greift die 404-Route der SPA.
    s = replace_once(
        s,
        '{label:"FAQ",to:"/faq"}];',
        '{label:"FAQ",to:"/faq"},{label:"Dashboard",to:"/dashboard",ext:!0}];',
        "Hauptmenü (ec)",
    )
    nav_old = 'ec.map(a=>(0,ze.jsx)(If,{to:a.to,className:Oh,children:a.label},a.to))'
    # Dashboard-Link je nach Bereich: von /praxen in die Praxis-Ansicht, sonst in die Unternehmens-Ansicht
    nav_new = 'ec.map(a=>a.ext?(0,ze.jsx)("a",{href:a.to+(a.to==="/dashboard"?"/?modus="+(String(l||"").startsWith("/praxen")?"praxis":"unternehmen"):""),className:Oh({isActive:!1}),children:a.label},a.to):(0,ze.jsx)(If,{to:a.to,className:Oh,children:a.label},a.to))'
    if s.count(nav_old) != 2:
        sys.exit("Menü-Rendering (Desktop + Mobil) nicht gefunden")
    s = s.replace(nav_old, nav_new)

    # Footer-Spalten (_h) nutzen dieselbe Liste: externe Einträge (/dashboard) ebenfalls als <a>
    s = replace_once(
        s,
        '(0,Te.jsx)(Ve,{to:l.to,className:"hover:text-slate-900",children:l.label})',
        'l.ext?(0,Te.jsx)("a",{href:l.to+(l.to==="/dashboard"?"/?modus="+(typeof location<"u"&&location.pathname.startsWith("/praxen")?"praxis":"unternehmen"):""),className:"hover:text-slate-900",children:l.label}):(0,Te.jsx)(Ve,{to:l.to,className:"hover:text-slate-900",children:l.label})',
        "Footer-Links",
    )

    # 4d) Seite für Praxen: Route /praxen (SwPraxenPage aus PraxenPage.jsx) und Menüpunkt „Für Praxen“
    s = replace_once(
        s,
        '(0,ne.jsx)(ft,{path:"ki-agent",element:(0,ne.jsx)(fr,{})}),',
        '(0,ne.jsx)(ft,{path:"ki-agent",element:(0,ne.jsx)(fr,{})}),(0,ne.jsx)(ft,{path:"praxen",element:(0,ne.jsx)(SwPraxenPage,{})}),',
        "Route /praxen",
    )
    s = replace_once(s, '{label:"KI-Agent",to:"/ki-agent"},', '{label:"KI-Agent",to:"/ki-agent"},{label:"F\\xFCr Praxen",to:"/praxen"},', "Menüpunkt Praxen")

    # 4e) Impressum: Rechtsform "Einzelunternehmen" (VITE_COMPANY_LEGAL_FORM). Inhaber statt "Vertreten durch",
    #     Registereintrag und USt-IdNr. nur, wenn ausgefüllt (kein Handelsregister / keine USt-IdNr. ist dort zulässig).
    #     Sonst würden deren Platzhalter die Seite dauerhaft als unvollständig (noindex) markieren.
    ez = '(fl.VITE_COMPANY_LEGAL_FORM||"").trim()==="Einzelunternehmen"'
    s = replace_once(
        s,
        'representative:Yl(fl.VITE_COMPANY_REPRESENTATIVE,"Vertretungsberechtigte Person"),register:Yl(fl.VITE_COMPANY_REGISTER,"Registergericht und -nummer"),vatId:Yl(fl.VITE_COMPANY_VAT_ID,"USt-IdNr."),',
        f'legalForm:(fl.VITE_COMPANY_LEGAL_FORM||"").trim()||null,'
        f'representative:{ez}?((fl.VITE_COMPANY_REPRESENTATIVE||"").trim()||Yl(fl.VITE_COMPANY_NAME,"Firma / Rechtsform")):Yl(fl.VITE_COMPANY_REPRESENTATIVE,"Vertretungsberechtigte Person"),'
        f'register:{ez}&&!(fl.VITE_COMPANY_REGISTER||"").trim()?null:Yl(fl.VITE_COMPANY_REGISTER,"Registergericht und -nummer"),'
        f'vatId:{ez}&&!(fl.VITE_COMPANY_VAT_ID||"").trim()?null:Yl(fl.VITE_COMPANY_VAT_ID,"USt-IdNr."),',
        "Impressum-Felder (Einzelunternehmen)",
    )
    s = replace_once(
        s,
        '(0,x.jsxs)("section",{children:[(0,x.jsx)(Ie,{children:"Vertreten durch"}),(0,x.jsx)("p",{className:"mt-2",children:ht.representative})]}),(0,x.jsxs)("section",{children:[(0,x.jsx)(Ie,{children:"Registereintrag"}),(0,x.jsx)("p",{className:"mt-2",children:ht.register})]}),(0,x.jsxs)("section",{children:[(0,x.jsx)(Ie,{children:"Umsatzsteuer-Identifikationsnummer"}),(0,x.jsx)("p",{className:"mt-2",children:ht.vatId})]})',
        '(0,x.jsxs)("section",{children:[(0,x.jsx)(Ie,{children:ht.legalForm==="Einzelunternehmen"?"Inhaber":"Vertreten durch"}),(0,x.jsx)("p",{className:"mt-2",children:ht.legalForm?[ht.representative," (",ht.legalForm,")"]:ht.representative})]}),ht.register&&(0,x.jsxs)("section",{children:[(0,x.jsx)(Ie,{children:"Registereintrag"}),(0,x.jsx)("p",{className:"mt-2",children:ht.register})]}),ht.vatId&&(0,x.jsxs)("section",{children:[(0,x.jsx)(Ie,{children:"Umsatzsteuer-Identifikationsnummer"}),(0,x.jsx)("p",{className:"mt-2",children:ht.vatId})]})',
        "Impressum-Abschnitte (Einzelunternehmen)",
    )

    # 4f) Preisseite: Abo-Checkout über Stripe (SwPlanCta/SwBillingNotice aus SitePatches.jsx).
    #     Der ursprüngliche Button bleibt als fallback erhalten – ohne /api/billing/config {enabled:true} ändert sich nichts.
    plan_cta = '(0,b.jsxs)(P,{as:"a",href:ot,variant:a?"primary":"secondary",className:"w-full",children:[i?"Kostenlos starten":`${K.trial.days} Tage testen`,(0,b.jsx)(rt,{size:14})]})'
    s = replace_once(s, plan_cta, '(0,b.jsx)(SwPlanCta,{id:e,yearly:l,highlight:a,fallback:' + plan_cta + '})', "Preiskarte-Button (Mp)")
    s = replace_once(
        s,
        '(0,b.jsx)("div",{className:"mt-10 grid gap-6 md:grid-cols-2 xl:grid-cols-4",children:hu.map(',
        '(0,b.jsx)(SwBillingNotice,{}),(0,b.jsx)("div",{className:"mt-10 grid gap-6 md:grid-cols-2 xl:grid-cols-4",children:hu.map(',
        "Preisseite: Testmodus-Hinweis (rr)",
    )

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
