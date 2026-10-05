// resume.jsonc を読み込んで職務経歴書を描画する。
// 値はすべて textContent で入れるため、JSON に HTML を書いても文字としてそのまま表示される。

const DATA_URL = "resume.jsonc";

// JSONC（コメントと末尾のカンマ）を JSON.parse できる形にする。
// 文字列の中の // や /* や「, ]」は残す。エラー位置の行番号がずれないよう、コメント内の改行は残す。
function stripJsonc(text) {
  // 位置 j から空白とコメントを飛ばした先の位置を返す
  const skip = (j) => {
    while (j < text.length) {
      if (/\s/.test(text[j])) j++;
      else if (text[j] === "/" && text[j + 1] === "/") { while (j < text.length && text[j] !== "\n") j++; }
      else if (text[j] === "/" && text[j + 1] === "*") { const k = text.indexOf("*/", j + 2); j = k < 0 ? text.length : k + 2; }
      else break;
    }
    return j;
  };
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close < 0 ? text.length : close + 2;
      out += text.slice(i, end).replace(/[^\n]/g, "");
      i = end - 1;
    } else if (c === ",") {
      // 次に来るのが } か ] なら末尾のカンマとして捨てる
      const next = text[skip(i + 1)];
      if (next !== "}" && next !== "]") out += c;
    } else {
      out += c;
    }
  }
  return out;
}

class DataError extends Error {}

function parseJsonc(text) {
  const json = stripJsonc(text);
  try {
    return JSON.parse(json);
  } catch (err) {
    // 「position 1234」から行番号を出す（コメント内の改行は残してあるので元ファイルの行と一致する）
    const pos = Number(/position (\d+)/.exec(err.message)?.[1]);
    const line = Number.isFinite(pos) ? json.slice(0, pos).split("\n").length : null;
    throw new DataError(`${DATA_URL} の書き方に誤りがあります${line ? `（${line}行目付近）` : ""}。\n${err.message}`);
  }
}

// 文中の「※1」を、末尾の注釈へリンクする上付きの番号にする
function withNoteRefs(text) {
  const parts = text.split(/(※\d+)/);
  return parts.map((part, i) => {
    if (i % 2 === 0) return part;
    const sup = document.createElement("sup");
    sup.className = "note-ref";
    const a = document.createElement("a");
    a.href = `#note-${part.slice(1)}`;
    a.textContent = part;
    sup.append(a);
    return sup;
  }).filter((x) => x !== "");
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === "") continue;
    if (child instanceof Node) node.append(child);
    else node.append(...withNoteRefs(String(child)));
  }
  return node;
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}年${m}月${d}日 現在`;
}

// 生年月日（YYYY-MM-DD）から、基準日（YYYY-MM-DD）時点の満年齢を返す
function ageAt(birthday, baseIso) {
  const [by, bm, bd] = birthday.split("-").map(Number);
  const [y, m, d] = baseIso.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

// "2014-05" から終了時期（なければ基準日）までの経験年数を「12年」の形で返す
function yearsSince(since, baseIso, until) {
  if (!since) return "";
  const [sy, sm] = since.split("-").map(Number);
  const [by, bm] = (until || baseIso).split("-").map(Number);
  const months = (by * 12 + bm) - (sy * 12 + sm);
  const years = Math.floor(months / 12);
  return years < 1 ? "1年未満" : `${years}年`;
}

// タグに添える経験年数。終了時期があるものは「4年・〜2018年」のように終わった年も出す
function experienceLabel(item, base) {
  const years = yearsSince(item.since, base, item.until);
  if (!item.until) return years;
  const endYear = `〜${item.until.slice(0, 4)}年`;
  return years ? `${years}・${endYear}` : endYear;
}

// ---------- 推しの技術 ----------
// スキル欄のタグに "featured": true を付けると推しになる。職務経歴の同じ名前のタグにも色が付く。
// 「AWS（Lambda, S3）」→「AWS」のように、括弧書きを除いた名前で照合する
const baseName = (name) => name.split(/[（(]/)[0].trim();

function toIsoMonth(jp) {
  const m = /(\d{4})年(\d{1,2})月/.exec(jp);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}` : null;
}

// 案件と、その下のサブプロジェクトで使った技術をまとめて返す
const allTech = (p) => [...(p.tech ?? []), ...(p.subprojects ?? []).flatMap((s) => s.tech ?? [])];

// 名前のアルファベット順（英字の後に日本語。大文字・小文字は区別しない）
const byName = new Intl.Collator("ja", { sensitivity: "base", numeric: true });

// スキルのタグを、推し → 特になし → 嫌い の順に並べ、同じ区分の中はアルファベット順にする。
// 色と同じく名前で判定する（同じ名前のタグが別の工程で推しなら、ここでも推しとして扱う）
function sortByLiking(tags) {
  const rank = (t) => (FEATURED(t.name) ? 0 : DISLIKED(t.name) ? 2 : 1);
  return [...tags].sort((a, b) => rank(a) - rank(b) || byName.compare(a.name, b.name));
}

// スキルのタグの featured：true は推し、null は特になし、false は嫌い
function collectFeatured(d) {
  const allTags = d.skills.phases
    .flatMap((ph) => ph.children ?? [ph])
    .flatMap((group) => group.tags ?? []);
  const featured = allTags.filter((t) => t.featured === true);
  const names = new Set(featured.map((t) => baseName(t.name)));
  const disliked = new Set(allTags.filter((t) => t.featured === false).map((t) => baseName(t.name)));
  const projects = d.companies.flatMap((c) => c.projects);

  const list = featured.map((t) => {
    // since がなければ、その技術を使った最初の案件の開始時期から数える
    const firstUse = projects
      .filter((p) => allTech(p).some((x) => baseName(x) === baseName(t.name)))
      .map((p) => toIsoMonth(p.period.from))
      .filter(Boolean)
      .sort()[0];
    return { name: t.name, since: t.since ?? firstUse ?? null, until: t.until ?? null };
  });
  list.sort((a, b) => byName.compare(a.name, b.name));
  return {
    list,
    isFeatured: (name) => names.has(baseName(name)),
    isDisliked: (name) => disliked.has(baseName(name)),
  };
}

function renderFeatured(featured, base) {
  if (!featured.list.length) return null;
  return section("featured", "推しの技術",
    el("p", { class: "tags" }, featured.list.map((f) => tag(f.name, experienceLabel(f, base), "tag", !!f.until))));
}

function section(id, title, ...content) {
  return el("section", { class: `block ${id}`, id }, el("h2", {}, title), ...content);
}

let FEATURED = () => false;
let DISLIKED = () => false;

function tag(name, extra, cls = "tag", past = false) {
  const featured = cls === "tag" && FEATURED(name);
  const disliked = cls === "tag" && !featured && DISLIKED(name);
  const classes = [cls, featured ? "tag-featured" : "", disliked ? "tag-disliked" : "", past ? "tag-past" : ""]
    .filter(Boolean).join(" ");
  return el("span", { class: classes },
    name, extra ? el("span", { class: "tag-sub" }, extra) : null);
}

// プロジェクト名 → アンカー ID（強みや実績から職務経歴へリンクする）
function buildProjectIndex(companies) {
  const index = new Map();
  companies.forEach((c, ci) => c.projects.forEach((p, pi) => index.set(p.title, `p-${ci}-${pi}`)));
  return index;
}

function projectLink(title, index) {
  const id = index.get(title);
  const label = title.replace(/^[^｜]+｜/, "");
  return id ? el("a", { href: `#${id}` }, label) : label;
}

function renderHeader(d) {
  return el("header", { class: "head" },
    // 1行目：氏名（左）と、日付・年齢・居住地（右）
    el("div", { class: "head-row" },
      el("div", { class: "head-main" },
        el("p", { class: "doc-title" }, d.title),
        el("h1", {}, d.name, d.nameEn ? el("span", { class: "name-en" }, d.nameEn) : null),
      ),
      el("div", { class: "head-meta" },
        d.updatedAt ? el("p", {}, formatDate(d.updatedAt)) : null,
        // 年齢と居住地は「37歳 / 大阪府」のように1行にまとめる（どちらかが null なら片方だけ）
        el("p", {}, [d.birthday && d.updatedAt ? `${ageAt(d.birthday, d.updatedAt)}歳` : null, d.location]
          .filter(Boolean).join(" / ")),
      ),
    ),
    // 2行目：肩書き。右の欄に幅を取られないよう全幅で表示し、「 / 」で区切った単位の途中では折り返さない
    d.tagline
      ? el("p", { class: "tagline" }, d.tagline.split("/").map((part, i) => [
        i ? el("span", { class: "tagline-sep" }, " / ") : null,
        el("span", { class: "tagline-item" }, part.trim()),
      ]))
      : null,
  );
}

function renderProfile(p) {
  if (!p) return null;
  return section("profile", "プロフィール",
    p.motto ? el("p", { class: "motto" }, `「${p.motto}」`) : null,
    (p.body ?? []).map((t) => el("p", {}, t)),
    p.favorites?.length
      ? [
        el("h3", { class: "sub-title" }, "好きなもの"),
        // 推しや嫌いの色は付けず、通常のタグで並べる
        el("p", { class: "tags" }, p.favorites.map((f) => el("span", { class: "tag" }, f))),
      ]
      : null,
  );
}

function renderStrengths(list, index) {
  if (!list?.length) return null;
  return section("strengths", "強み",
    el("div", { class: "cards" }, list.map((s) =>
      el("article", { class: "card" },
        el("h3", {}, s.title),
        el("p", {}, s.body),
        s.evidence?.length
          ? el("p", { class: "evidence" }, el("span", { class: "evidence-label" }, "主な実績"),
            s.evidence.map((t, i) => [i ? "、" : "", projectLink(t, index)]))
          : null,
      ))),
  );
}

function renderHighlights(list, index) {
  if (!list?.length) return null;
  return section("highlights", "主な実績",
    el("ol", { class: "highlights-list" }, list.map((h) =>
      el("li", {},
        // ref が案件名と一致しないときはリンクにしない
        el("h3", {}, index.has(h.ref) ? el("a", { href: `#${index.get(h.ref)}` }, h.title) : h.title),
        el("p", {}, h.body),
      ))),
  );
}

function bodyRows(p) {
  const rows = [
    ["課題", p.problem],
    ["取り組み", p.approach],
    ["成果", p.outcome],
  ].filter(([, v]) => v);
  return rows.length
    ? el("dl", { class: "project-body" }, rows.map(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]))
    : null;
}

function renderSubproject(s) {
  return el("section", { class: "subproject" },
    el("div", { class: "project-head" },
      el("h5", {}, s.title),
      s.period ? el("p", { class: "project-period" }, `${s.period.from} 〜 ${s.period.to}`) : null,
    ),
    s.roles?.length ? el("p", { class: "roles" }, s.roles.map((r) => tag(r, null, "role"))) : null,
    bodyRows(s),
    s.tech?.length ? el("p", { class: "tags" }, s.tech.map((t) => tag(t))) : null,
  );
}

function renderProject(p, id) {
  const subs = p.subprojects ?? [];
  return el("article", { class: subs.length ? "project has-subprojects" : "project", id },
    el("div", { class: "project-head" },
      el("h4", {}, p.title),
      el("p", { class: "project-period" }, `${p.period.from} 〜 ${p.period.to}`),
    ),
    p.roles?.length || p.scale
      ? el("p", { class: "roles" },
        (p.roles ?? []).map((r) => tag(r, null, "role")),
        p.scale ? tag(p.scale, null, "role role-scale") : null)
      : null,
    bodyRows(p),
    p.tech?.length ? el("p", { class: "tags" }, p.tech.map((t) => tag(t))) : null,
    subs.length
      ? el("div", { class: "subprojects" },
        el("p", { class: "subprojects-label" }, "この案件での主な取り組み"),
        subs.map(renderSubproject))
      : null,
  );
}

function renderCareer(companies) {
  return section("career", "職務経歴",
    el("div", { class: "timeline" }, companies.map((c, ci) =>
      el("div", { class: "company" },
        el("div", { class: "company-head" },
          el("h3", {}, c.name, c.position ? el("span", { class: "position" }, c.position) : null),
          el("p", { class: "company-period" }, `${c.period.from} 〜 ${c.period.to}`),
        ),
        c.projects.map((p, pi) => renderProject(p, `p-${ci}-${pi}`)),
      ))),
  );
}

function renderSkills(s, base) {
  const tags = (list) => el("p", { class: "tags" },
    sortByLiking(list).map((t) => tag(t.name, experienceLabel(t, base), "tag", !!t.until)));
  const phases = el("div", { class: "phases" }, s.phases.map((ph) =>
    el("div", { class: "phase" },
      el("h3", { class: "phase-name" }, ph.name),
      ph.children
        ? el("div", { class: "phase-children" }, ph.children.map((c) =>
          el("div", { class: "phase-child" }, el("h4", {}, c.name), tags(c.tags ?? []))))
        : tags(ph.tags ?? []),
    )));
  const axes = el("div", { class: "axes" }, s.axes.map((a) =>
    el("article", { class: "axis" },
      el("div", { class: "axis-head" },
        el("h4", {}, a.name),
        el("span", { class: "axis-years" }, experienceLabel(a, base))),
      el("p", { class: "tags" }, (a.items ?? []).map((i) => tag(i))),
    )));
  return section("skills", "スキル",
    el("h3", { class: "sub-title" }, "工程別"),
    phases,
    el("h3", { class: "sub-title" }, "役割の軸"),
    axes,
    s.note ? el("p", { class: "note" }, `※${s.note}`) : null,
  );
}

function renderAi(ai) {
  if (!ai?.summary) return null;
  return section("ai", "AI活用",
    el("p", {}, ai.summary),
    ai.note ? el("p", { class: "note" }, ai.note) : null,
  );
}

function renderQualifications(d) {
  return section("quals", "資格・学歴",
    el("div", { class: "two-col" },
      el("div", {},
        el("h3", { class: "sub-title" }, "資格"),
        // 年・期間の列と本文の列を、全行でそろえて並べる
        el("ul", { class: "dated" }, (d.certifications ?? []).map((c) =>
          el("li", {},
            el("span", { class: "dated-when" }, c.acquired ?? ""),
            el("span", { class: "dated-what" }, c.name))))),
      el("div", {},
        el("h3", { class: "sub-title" }, "学歴"),
        el("ul", { class: "dated" }, (d.education ?? []).map((e) =>
          el("li", {},
            el("span", { class: "dated-when" }, e.period),
            el("span", { class: "dated-what" }, [e.school, e.department].filter(Boolean).join(" "),
              e.note ? el("span", { class: "muted" }, `（${e.note}）`) : null))))),
    ),
  );
}

function renderLinks(links) {
  if (!links?.length) return null;
  return section("links", "付録：URL",
    el("dl", { class: "link-list" }, links.map((l) => [
      el("dt", {}, l.title),
      // 印刷しても読めるよう、URL はそのまま表示する
      el("dd", {}, el("a", { href: l.url }, l.url)),
    ])),
  );
}

function render(d) {
  // PDF保存時の既定ファイル名になる（例: 職務経歴書_藤本永一_20261005）
  document.title = [d.title, d.name?.replace(/\s/g, ""), d.updatedAt?.replace(/-/g, "")].filter(Boolean).join("_");
  const index = buildProjectIndex(d.companies);
  const featured = collectFeatured(d);
  FEATURED = featured.isFeatured;
  DISLIKED = featured.isDisliked;
  // replaceChildren は null を「null」という文字として追加するので、表示しないセクションは取り除く
  const sections = [
    renderHeader(d),
    renderProfile(d.profile),
    renderStrengths(d.strengths, index),
    renderHighlights(d.highlights, index),
    renderFeatured(featured, d.updatedAt),
    renderCareer(d.companies),
    d.skills ? renderSkills(d.skills, d.updatedAt) : null,
    renderAi(d.ai),
    renderQualifications(d),
    renderLinks(d.links),
    d.notes?.length
      ? el("ol", { class: "footnotes" }, d.notes.map((n, i) =>
        // 番号は上付きのリンクにしないよう、文字ノードとして渡す
        el("li", { id: `note-${i + 1}` }, el("span", { class: "footnote-label" }, document.createTextNode(`※${i + 1}`)), n)))
      : null,
    d.privacyNote ? el("p", { class: "privacy" }, d.privacyNote) : null,
    el("p", { class: "end" }, "以上"),
  ];
  document.getElementById("resume").replaceChildren(...sections.filter(Boolean));
}

// 描画の成否を <html data-state="ready|error"> に残す（make-pdf.ps1 が PDF にする前に確かめる）
function showError(message) {
  document.documentElement.dataset.state = "error";
  document.getElementById("resume").replaceChildren(el("p", { class: "error" }, message));
}

class LoadError extends Error {}

fetch(DATA_URL)
  .catch(() => {
    throw new LoadError(
      `${DATA_URL} を読み込めませんでした。\n` +
      "index.html を直接開くと、ブラウザの制限で読み込めません。RESUME_HTML フォルダでローカルサーバーを起動して開いてください。\n" +
      "例: npx serve RESUME_HTML  または  python -m http.server -d RESUME_HTML");
  })
  .then((res) => {
    if (!res.ok) throw new LoadError(`${DATA_URL} の読み込みに失敗しました（HTTP ${res.status}）。`);
    return res.text();
  })
  .then((text) => {
    render(parseJsonc(text));
    document.documentElement.dataset.state = "ready";
  })
  .catch((err) => {
    console.error(err);
    showError(err instanceof LoadError || err instanceof DataError
      ? err.message
      : `表示中にエラーが発生しました。${DATA_URL} の項目が足りないか、値の形が違う可能性があります。\n${err.message}`);
  });
