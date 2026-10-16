const state = {
  target: { weekday: 110000, weekend: 140000 },
  nights: { weekday: 16, weekend: 8 },
  platforms: {
    airbnb:  { label: "에어비앤비", code: "AB", cls: "ab", commission: 15.5, weight: 0, promos: [{ name: "조기예약 할인", rate: 5 }] },
    booking: { label: "부킹닷컴",   code: "BK", cls: "bk", commission: 17.5, weight: 5, promos: [
      { name: "베이직 할인", rate: 50 },
      { name: "모바일 할인", rate: 10 },
      { name: "지니어스 할인", rate: 10 },
    ] },
    trip:    { label: "트립닷컴",   code: "TR", cls: "tr", commission: 15.5, weight: 8, promos: [
      { name: "모바일 할인", rate: 10 },
      { name: "회원할인", rate: 15 },
    ] },
  },
  taxBasis: "airbnb",
  tax: { expenseMethod: "simple" },
};

// 국세청 업종코드 551007(공유숙박업) 기준, 2023년 귀속 고시 경비율.
// 국세청이 매년 갱신하므로 최신 고시 확인 필요.
const EXPENSE_RATIOS = { simple: 84.6, standard: 17.3 };
const SIMPLIFIED_VAT_THRESHOLD = 104000000; // 간이과세자 기준: 직전연도 공급대가 1억4백만원 미만

// 2025년 종합소득세 누진세율표 (지방소득세 별도)
const TAX_BRACKETS = [
  { limit: 14000000, rate: 0.06, deduction: 0 },
  { limit: 50000000, rate: 0.15, deduction: 1260000 },
  { limit: 88000000, rate: 0.24, deduction: 5760000 },
  { limit: 150000000, rate: 0.35, deduction: 15440000 },
  { limit: 300000000, rate: 0.38, deduction: 19940000 },
  { limit: 500000000, rate: 0.4, deduction: 25940000 },
  { limit: 1000000000, rate: 0.42, deduction: 35940000 },
  { limit: Infinity, rate: 0.45, deduction: 65940000 },
];

const won = (n) => Math.round(n).toLocaleString("ko-KR") + "원";
const pct = (n) => (Math.round(n * 10) / 10).toLocaleString("ko-KR") + "%";
const roundPrice = (n) => Math.round(n / 100) * 100;

function discountFactor(promos) {
  return promos.reduce((acc, p) => acc * (1 - (p.rate || 0) / 100), 1);
}

function calcPlatform(platform, target) {
  const commission = platform.commission / 100;
  const df = discountFactor(platform.promos);
  const weight = platform.weight / 100;
  const out = {};
  for (const day of ["weekday", "weekend"]) {
    const net = target[day];
    const rawList = net / ((1 - commission) * df);
    const finalList = rawList * (1 + weight);
    const guestPays = finalList * df;
    const actualNet = guestPays * (1 - commission);
    out[day] = { net, finalList, guestPays, actualNet, totalDiscountPct: (1 - df) * 100 };
  }
  return out;
}

function calcIncomeTax(taxable) {
  if (taxable <= 0) return 0;
  const b = TAX_BRACKETS.find((b) => taxable <= b.limit);
  return Math.max(0, taxable * b.rate - b.deduction);
}

const VAT_EXEMPT_THRESHOLD = 48000000; // 간이과세자 납부의무 면제 기준: 연 공급대가 4,800만원 미만

function calcVAT(annualRevenue, type) {
  if (annualRevenue <= 0) return { vat: 0, supplyValue: 0, note: "", exempt: false };
  if (type === "simplified") {
    // 납부세액 = 공급대가(매출액) × 업종별 부가가치율(숙박업 25%) × 세율 10%. 국세청 고시 기준.
    const theoreticalVat = annualRevenue * 0.25 * 0.1;
    const exempt = annualRevenue < VAT_EXEMPT_THRESHOLD;
    const vat = exempt ? 0 : theoreticalVat;
    // 공급가액(소득세 계산 기초)은 면제 여부와 무관하게 매출에 내재된 부가가치 기준으로 산출
    const supplyValue = annualRevenue - theoreticalVat;
    const note = exempt
      ? "간이과세자 납부의무 면제 대상(연매출 4,800만원 미만)이라 부가가치세 납부액이 0원으로 계산되었습니다"
      : "간이과세자 추정(업종 부가가치율 25% 가정, 매입세액공제 매입액의 0.5%는 미반영해 실제보다 다소 높게 추정될 수 있음)";
    return { vat, supplyValue, note, exempt };
  }
  const supplyValue = annualRevenue / 1.1;
  return { vat: annualRevenue - supplyValue, supplyValue, note: "일반과세자 추정(매입세액공제 미반영, 단순 매출세액 기준)", exempt: false };
}

function computeAll() {
  const perPlatform = {};
  for (const [key, p] of Object.entries(state.platforms)) {
    const calc = calcPlatform(p, state.target);
    const monthlyNet = state.nights.weekday * calc.weekday.actualNet + state.nights.weekend * calc.weekend.actualNet;
    perPlatform[key] = { ...p, calc, monthlyNet, annualNet: monthlyNet * 12 };
  }
  const basisAnnual = perPlatform[state.taxBasis].annualNet;
  const taxType = basisAnnual < SIMPLIFIED_VAT_THRESHOLD ? "simplified" : "general";
  const { vat, supplyValue, note, exempt } = calcVAT(basisAnnual, taxType);
  const expenseRatio = EXPENSE_RATIOS[state.tax.expenseMethod];
  const businessIncome = Math.max(0, supplyValue * (1 - expenseRatio / 100));
  const incomeTax = calcIncomeTax(businessIncome);
  const localIncomeTax = incomeTax * 0.1;
  const totalTax = vat + incomeTax + localIncomeTax;
  const afterTax = basisAnnual - totalTax;
  return { perPlatform, tax: { basisAnnual, taxType, vat, vatExempt: exempt, supplyValue, expenseRatio, businessIncome, incomeTax, localIncomeTax, totalTax, afterTax, note } };
}

function renderPlatformCards() {
  const root = document.getElementById("platform-cards");
  root.innerHTML = "";
  Object.entries(state.platforms).forEach(([key, p]) => {
    const block = document.createElement("div");
    block.className = "channel-block";
    block.innerHTML = `
      <div class="channel-head"><span class="chip ${p.cls}">${p.code}</span>${p.label}</div>
      <div class="field-row">
        <div class="field">
          <label>수수료율</label>
          <div class="unit-input"><input type="number" step="0.1" data-key="${key}" data-field="commission" value="${p.commission}"><span class="unit">%</span></div>
        </div>
        <div class="field">
          <label>가중치</label>
          <div class="unit-input"><input type="number" step="1" data-key="${key}" data-field="weight" value="${p.weight}"><span class="unit">%</span></div>
        </div>
      </div>
      <div class="promo-list" data-promo-list="${key}"></div>
      <button type="button" class="ghost-btn" data-add-promo="${key}">+ 프로모션 추가</button>
    `;
    root.appendChild(block);
    renderPromoRows(key);
  });

  root.querySelectorAll("input[data-field]").forEach((input) => {
    input.addEventListener("input", (e) => {
      const { key, field } = e.target.dataset;
      state.platforms[key][field] = parseFloat(e.target.value) || 0;
      renderResults();
    });
  });

  root.querySelectorAll("[data-add-promo]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.addPromo;
      state.platforms[key].promos.push({ name: "새 프로모션", rate: 5 });
      renderPromoRows(key);
      renderResults();
    });
  });
}

function renderPromoRows(key) {
  const list = document.querySelector(`[data-promo-list="${key}"]`);
  const platform = state.platforms[key];
  list.innerHTML = "";
  platform.promos.forEach((promo, idx) => {
    const row = document.createElement("div");
    row.className = "promo-row";
    row.innerHTML = `
      <input type="text" value="${promo.name}" data-promo-key="${key}" data-promo-idx="${idx}" data-promo-field="name">
      <input type="number" step="1" value="${promo.rate}" data-promo-key="${key}" data-promo-idx="${idx}" data-promo-field="rate">
      <button type="button" class="icon-btn" data-remove-promo="${key}:${idx}">✕</button>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll("input[data-promo-field]").forEach((input) => {
    input.addEventListener("input", (e) => {
      const { promoKey, promoIdx, promoField } = e.target.dataset;
      const val = promoField === "rate" ? parseFloat(e.target.value) || 0 : e.target.value;
      state.platforms[promoKey].promos[promoIdx][promoField] = val;
      renderResults();
    });
  });

  list.querySelectorAll("[data-remove-promo]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [k, i] = btn.dataset.removePromo.split(":");
      state.platforms[k].promos.splice(Number(i), 1);
      renderPromoRows(k);
      renderResults();
    });
  });
}

function renderResults() {
  const result = computeAll();

  // price table — grouped by day-type since 목표 순수익 is shared across platforms
  const body = document.getElementById("price-body");
  const dayLabel = { weekday: "평일", weekend: "주말" };
  let rows = "";
  for (const day of ["weekday", "weekend"]) {
    rows += `
      <tr class="group-row">
        <td colspan="4"><span class="group-day">${dayLabel[day]}</span><span class="group-target">목표 순수익 ${won(state.target[day])}</span></td>
      </tr>`;
    for (const [key, p] of Object.entries(result.perPlatform)) {
      const c = p.calc[day];
      rows += `
        <tr>
          <td><div class="row-channel"><span class="chip ${p.cls}">${p.code}</span>${p.label}</div></td>
          <td data-label="게시가" class="price-highlight">${won(roundPrice(c.finalList))}</td>
          <td data-label="게스트 결제가"><span class="discount-pill">총할인 ${pct(c.totalDiscountPct)}</span> ${won(roundPrice(c.guestPays))}</td>
          <td data-label="실제 순수익">${p.weight ? `<span class="weight-pill">가중치 ${pct(p.weight)}</span> ` : ""}${won(roundPrice(c.actualNet))}</td>
        </tr>`;
    }
  }
  body.innerHTML = rows;

  // comparison grid
  const grid = document.getElementById("compare-grid");
  const monthlyValues = Object.values(result.perPlatform).map((p) => p.monthlyNet);
  const maxMonthly = Math.max(...monthlyValues);
  grid.innerHTML = Object.entries(result.perPlatform)
    .map(([key, p]) => {
      const isBest = p.monthlyNet === maxMonthly && maxMonthly > 0;
      return `
      <div class="compare-cell ${p.cls}">
        ${isBest ? `<span class="best-tag">가장 높음</span>` : ""}
        <div class="row-channel"><span class="chip ${p.cls}">${p.code}</span>${p.label}</div>
        <p class="figure-label">월 순수익</p>
        <p class="figure">${won(p.monthlyNet)}</p>
        <p class="figure-label">연 순수익</p>
        <p class="figure annual">${won(p.annualNet)}</p>
      </div>`;
    })
    .join("");

  // tax
  const t = result.tax;
  const pill = document.getElementById("tax-type-pill");
  pill.classList.toggle("is-general", t.taxType === "general");
  document.getElementById("tax-type-label").textContent =
    t.taxType === "general"
      ? `일반과세자 (연매출 1억 4백만원 이상)`
      : `간이과세자 (연매출 1억 4백만원 미만)`;

  document.getElementById("tax-final").textContent = won(t.afterTax);

  document.getElementById("tax-body").innerHTML = `
    <div class="tax-line"><span>부가가치세 납부(추정)</span><span>${won(t.vat)}${t.vatExempt ? '<span class="exempt-tag">납부면제</span>' : ""}</span></div>
    <div class="tax-line"><span>종합소득세 납부(추정)</span><span>${won(t.incomeTax)}</span></div>
    <div class="tax-line"><span>지방소득세 (종합소득세의 10%)</span><span>${won(t.localIncomeTax)}</span></div>
    <div class="tax-line total"><span>세금 합계</span><span>${won(t.totalTax)}</span></div>
  `;

  document.getElementById("tax-detail").innerHTML = `
    <div class="tax-line"><span>연 매출 (${state.platforms[state.taxBasis].label} 기준, VAT 포함 가정)</span><span>${won(t.basisAnnual)}</span></div>
    <div class="tax-line"><span>공급가액 (부가세 제외)</span><span>${won(t.supplyValue)}</span></div>
    <div class="tax-line"><span>사업소득금액 (${state.tax.expenseMethod === "simple" ? "단순" : "기준"}경비율 ${t.expenseRatio}% 차감)</span><span>${won(t.businessIncome)}</span></div>
  `;

  document.getElementById("tax-note").textContent = `${t.note}. 경비율은 국세청 업종코드 551007(공유숙박업) 2023년 귀속 고시 기준으로, 매년 갱신되니 최신 고시를 확인하세요. 다른 종합소득 합산, 세액공제 등에 따라 실제 세액은 달라질 수 있습니다.`;
}

function bindBase() {
  [["target-weekday", "target", "weekday"], ["target-weekend", "target", "weekend"],
   ["nights-weekday", "nights", "weekday"], ["nights-weekend", "nights", "weekend"]].forEach(([id, a, b]) => {
    document.getElementById(id).addEventListener("input", (e) => {
      if (b) state[a][b] = parseFloat(e.target.value) || 0;
      else state[a] = parseFloat(e.target.value) || 0;
      renderResults();
    });
  });

  document.querySelectorAll("#tax-basis-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.taxBasis = btn.dataset.basis;
      document.querySelectorAll("#tax-basis-toggle button").forEach((b) => b.setAttribute("aria-pressed", b === btn));
      renderResults();
    });
  });

  document.querySelectorAll("#expense-method-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tax.expenseMethod = btn.dataset.method;
      document.querySelectorAll("#expense-method-toggle button").forEach((b) => b.setAttribute("aria-pressed", b === btn));
      renderResults();
    });
  });
}

renderPlatformCards();
bindBase();
renderResults();
