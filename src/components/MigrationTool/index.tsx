import React, { useState, useRef } from 'react';
import initSqlJs from 'sql.js';
import styles from './styles.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = 'upload' | 'analyzing' | 'preview' | 'done';

interface CurrencyMapping {
  legacyId: number;
  legacyName: string;
  mappedCode: string;
  nameAr: string;
  symbol: string;
}

interface GroupRecord {
  legacyId: number;
  name: string;
}

interface CustomerTypeRecord {
  legacyId: number;
  name: string;
}

interface AccountBalance {
  currencyCode: string;
  balance: number;
}

interface AccountRecord {
  legacyId: number;
  name: string;
  phone: string;
  groupLegacyId: number;
  groupName: string;
  customerTypeLegacyId: number;
  customerTypeName: string;
  balances: AccountBalance[];
  transactionCount: number;
  classification: string;
  metadata: Record<string, unknown>;
}

interface TransactionRecord {
  legacyId: number;
  counterpartyLegacyId: number;
  transferTargetLegacyId: number | null;
  amountRaw: number;
  type: 'receipt' | 'payment' | 'transfer';
  date: string;
  dateParsed: string;
  description: string;
  currencyCode: string;
  metadata: Record<string, unknown>;
}

interface MigrationBundle {
  version: string;
  sourceSystem: string;
  exportedAt: string;
  schemaType: 'simple' | 'advanced';
  currencies: CurrencyMapping[];
  groups: GroupRecord[];
  customerTypes: CustomerTypeRecord[];
  accounts: AccountRecord[];
  transactions: TransactionRecord[];
  stats: {
    accountsCount: number;
    transactionsCount: number;
    currenciesCount: number;
    groupsCount: number;
    transfersCount: number;
  };
}

// ─── Currency Intelligence ─────────────────────────────────────────────────────

const CURRENCY_MAP: Array<{ patterns: RegExp; code: string; nameAr: string; symbol: string }> = [
  { patterns: /سعودي|ريال سعودي|saudi|sar/i, code: 'SAR', nameAr: 'ريال سعودي', symbol: '﷼' },
  { patterns: /دولار|dollar|usd|امريكي|أمريكي/i, code: 'USD', nameAr: 'دولار أمريكي', symbol: '$' },
  { patterns: /محلي|local|يمني|ريال يمني|yer/i, code: 'YER', nameAr: 'ريال يمني', symbol: '﷼' },
  { patterns: /مصري|جنيه مصري|جنيه|egyptian|egp/i, code: 'EGP', nameAr: 'جنيه مصري', symbol: 'ج.م' },
  { patterns: /إماراتي|اماراتي|درهم|dirham|aed/i, code: 'AED', nameAr: 'درهم إماراتي', symbol: 'د.إ' },
  { patterns: /كويتي|دينار كويتي|kuwait|kwd/i, code: 'KWD', nameAr: 'دينار كويتي', symbol: 'د.ك' },
  { patterns: /بحريني|دينار بحريني|bahrain|bhd/i, code: 'BHD', nameAr: 'دينار بحريني', symbol: 'د.ب' },
  { patterns: /أردني|اردني|دينار أردني|jordan|jod/i, code: 'JOD', nameAr: 'دينار أردني', symbol: 'د.أ' },
  { patterns: /قطري|ريال قطري|qatar|qar/i, code: 'QAR', nameAr: 'ريال قطري', symbol: '﷼' },
  { patterns: /عماني|ريال عماني|oman|omr/i, code: 'OMR', nameAr: 'ريال عماني', symbol: '﷼' },
  { patterns: /يورو|euro|eur/i, code: 'EUR', nameAr: 'يورو', symbol: '€' },
  { patterns: /جنيه استرليني|sterling|gbp/i, code: 'GBP', nameAr: 'جنيه إسترليني', symbol: '£' },
  { patterns: /تركي|ليرة تركية|turkey|try/i, code: 'TRY', nameAr: 'ليرة تركية', symbol: '₺' },
];

const resolveCurrency = (name: string): Omit<CurrencyMapping, 'legacyId' | 'legacyName'> => {
  const n = (name || '').trim();
  for (const entry of CURRENCY_MAP) {
    if (entry.patterns.test(n)) {
      return { mappedCode: entry.code, nameAr: entry.nameAr, symbol: entry.symbol };
    }
  }
  return { mappedCode: 'USD', nameAr: `عملة (${n})`, symbol: n.substring(0, 3).toUpperCase() };
};

// ─── Date Parsing ──────────────────────────────────────────────────────────────

const parseDate = (raw: string): string => {
  if (!raw) return new Date().toISOString().split('T')[0];
  const s = raw.trim();
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {          // dd-mm-yyyy (primary legacy format)
    const [d, m, y] = s.split('-');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10); // yyyy-mm-dd
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {        // dd/mm/yyyy
    const [d, m, y] = s.split('/');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return new Date().toISOString().split('T')[0];
};

// ─── Constants ────────────────────────────────────────────────────────────────

const STEPS = ['رفع الملف', 'تحليل البيانات', 'مراجعة النتائج', 'تنزيل الحزمة'];

// ─── Component ────────────────────────────────────────────────────────────────

const MigrationTool: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('upload');
  const [bundle, setBundle] = useState<MigrationBundle | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pushLog = (msg: string) => setLog(prev => [...prev, msg]);

  // ── Core Processing ─────────────────────────────────────────────────────────
  const processBuffer = async (buffer: ArrayBuffer) => {
    setPhase('analyzing');
    setLog([]);

    try {
      pushLog('⬆️  جاري تحميل محرك قواعد البيانات (sql.js)...');
      const SQL = await initSqlJs({
        locateFile: (file) => `https://unpkg.com/sql.js@1.14.1/dist/${file}`
      });

      pushLog('📂 جاري فتح قاعدة البيانات...');
      const db = new SQL.Database(new Uint8Array(buffer));

      // ── Schema Detection ─────────────────────────────────────────────────
      let schemaType: 'simple' | 'advanced' = 'simple';
      try {
        const chk = db.exec("SELECT COUNT(*) FROM doc_hdr");
        if (chk.length > 0 && Number(chk[0].values[0][0]) > 0) {
          schemaType = 'advanced';
          pushLog('🔍 هيكل متقدم — سيتم استخدام جدول doc_hdr.');
        } else {
          pushLog('🔍 هيكل أساسي — سيتم استخدام جدول transactions.');
        }
      } catch {
        pushLog('🔍 هيكل أساسي (transactions).');
      }

      // ── Currencies ───────────────────────────────────────────────────────
      pushLog('💱 استخراج العملات...');
      const currencies: CurrencyMapping[] = [];
      const currById: Record<number, CurrencyMapping> = {};

      try {
        const rows = db.exec("SELECT ID, name FROM currency ORDER BY ID");
        if (rows.length > 0) {
          for (const row of rows[0].values) {
            const id = Number(row[0]);
            const name = String(row[1] ?? 'محلي');
            const mapped = resolveCurrency(name);
            const cm: CurrencyMapping = { legacyId: id, legacyName: name, ...mapped };
            currencies.push(cm);
            currById[id] = cm;
          }
        }
      } catch { /* no currency table */ }

      // Ensure default currency (ID=0)
      if (!currById[0]) {
        const def: CurrencyMapping = { legacyId: 0, legacyName: 'محلي', mappedCode: 'YER', nameAr: 'ريال يمني', symbol: '﷼' };
        currencies.unshift(def);
        currById[0] = def;
      }
      pushLog(`✅ ${currencies.length} عملة — ${currencies.map(c => c.mappedCode).join(', ')}`);

      // ── Groups ───────────────────────────────────────────────────────────
      pushLog('🗂️  استخراج المجموعات...');
      const groups: GroupRecord[] = [];
      const groupById: Record<number, string> = { 0: 'بدون مجموعة' };
      try {
        const rows = db.exec("SELECT ID, name FROM groups ORDER BY ID");
        if (rows.length > 0) {
          for (const row of rows[0].values) {
            const g: GroupRecord = { legacyId: Number(row[0]), name: String(row[1] ?? '') };
            groups.push(g);
            groupById[g.legacyId] = g.name;
          }
        }
      } catch { /* no groups */ }
      pushLog(`✅ ${groups.length} مجموعة`);

      // ── Customer Types ────────────────────────────────────────────────────
      const customerTypes: CustomerTypeRecord[] = [];
      const typeById: Record<number, string> = { 0: 'افتراضي' };
      try {
        const rows = db.exec("SELECT id, name FROM cus_type ORDER BY id");
        if (rows.length > 0) {
          for (const row of rows[0].values) {
            const ct: CustomerTypeRecord = { legacyId: Number(row[0]), name: String(row[1] ?? '') };
            customerTypes.push(ct);
            typeById[ct.legacyId] = ct.name;
          }
        }
      } catch { /* no cus_type */ }

      // ── Accounts ─────────────────────────────────────────────────────────
      pushLog('👤 استخراج الحسابات...');
      const accounts: AccountRecord[] = [];
      const accById: Record<number, AccountRecord> = {};
      try {
        const rows = db.exec("SELECT ID, name, gsm, g_id, cus_type_id FROM customers ORDER BY ID");
        if (rows.length > 0) {
          for (const row of rows[0].values) {
            const id = Number(row[0]);
            const gId = Number(row[3] ?? 0);
            const tId = Number(row[4] ?? 0);
            const acc: AccountRecord = {
              legacyId: id,
              name: String(row[1] ?? ''),
              phone: String(row[2] ?? ''),
              groupLegacyId: gId,
              groupName: groupById[gId] ?? 'بدون مجموعة',
              customerTypeLegacyId: tId,
              customerTypeName: typeById[tId] ?? 'افتراضي',
              balances: [],
              transactionCount: 0,
              classification: 'party',
              metadata: { source: 'legacy_import', original_id: id },
            };
            accounts.push(acc);
            accById[id] = acc;
          }
        }
      } catch (e) {
        pushLog(`⚠️  خطأ في الحسابات: ${e}`);
      }
      pushLog(`✅ ${accounts.length} حساب`);

      // ── Transactions ──────────────────────────────────────────────────────
      pushLog('📊 استخراج الحركات المالية...');
      const transactions: TransactionRecord[] = [];
      let transfersCount = 0;

      const balanceMap: Record<string, number> = {};
      const txCountMap: Record<number, number> = {};

      const query = schemaType === 'advanced'
        ? `SELECT id, cus_id, [in], out, date_, remarks, curr_id, t_cus_id FROM doc_hdr`
        : `SELECT ID,  cus_id, [in], out, date_, remarks, curr_id, t_cus_id FROM transactions`;

      try {
        const rows = db.exec(query);
        if (rows.length > 0) {
          for (const row of rows[0].values) {
            const id = Number(row[0]);
            const cusId = Number(row[1]);
            const inFlag = row[2];
            const amount = parseFloat(String(row[3] ?? '0'));
            const dateRaw = String(row[4] ?? '');
            const remarks = String(row[5] ?? '');
            const currId = Number(row[6] ?? 0);
            const tCusId = row[7];

            if (amount <= 0 || !cusId) continue;

            const currency = currById[currId] ?? currById[0];
            const currCode = currency?.mappedCode ?? 'YER';
            const isIn = inFlag === 1 || inFlag === '1';
            const isTransfer = tCusId !== null && tCusId !== undefined && Number(tCusId) > 0 && Number(tCusId) !== cusId;
            const type: 'receipt' | 'payment' | 'transfer' = isTransfer ? 'transfer' : (isIn ? 'receipt' : 'payment');
            if (isTransfer) transfersCount++;

            transactions.push({
              legacyId: id,
              counterpartyLegacyId: cusId,
              transferTargetLegacyId: isTransfer ? Number(tCusId) : null,
              amountRaw: amount,
              type,
              date: dateRaw,
              dateParsed: parseDate(dateRaw),
              description: remarks,
              currencyCode: currCode,
              metadata: { source: 'legacy_import', original_id: id },
            });

            // Balance tracking (legacy formula: receipt → debt+, payment → debt-)
            const bKey = `${cusId}|${currCode}`;
            balanceMap[bKey] = (balanceMap[bKey] ?? 0) + (isIn ? amount : -amount);
            txCountMap[cusId] = (txCountMap[cusId] ?? 0) + 1;

            if (isTransfer && tCusId) {
              const tId = Number(tCusId);
              const tKey = `${tId}|${currCode}`;
              balanceMap[tKey] = (balanceMap[tKey] ?? 0) - amount;
              txCountMap[tId] = (txCountMap[tId] ?? 0) + 1;
            }
          }
        }
      } catch (e) {
        pushLog(`⚠️  خطأ في الحركات: ${e}`);
      }

      // Apply balances and counts to accounts
      for (const acc of accounts) {
        acc.transactionCount = txCountMap[acc.legacyId] ?? 0;
        for (const [key, bal] of Object.entries(balanceMap)) {
          const [aIdStr, currCode] = key.split('|');
          if (Number(aIdStr) === acc.legacyId && Math.abs(bal) > 0.001) {
            acc.balances.push({ currencyCode: currCode, balance: Math.round(bal * 100) / 100 });
          }
        }
      }

      pushLog(`✅ ${transactions.length} حركة (منها ${transfersCount} تحويل بين حسابات)`);

      db.close();

      const result: MigrationBundle = {
        version: '2.0',
        sourceSystem: 'Legacy-Market',
        exportedAt: new Date().toISOString(),
        schemaType,
        currencies,
        groups,
        customerTypes,
        accounts,
        transactions,
        stats: {
          accountsCount: accounts.length,
          transactionsCount: transactions.length,
          currenciesCount: currencies.length,
          groupsCount: groups.length,
          transfersCount,
        },
      };

      setBundle(result);
      setPhase('preview');
      // Auto-expand first group
      if (accounts.length > 0) {
        const firstGroup = accounts[0].groupName;
        setExpandedGroups(new Set([firstGroup]));
      }
      pushLog('🎉 اكتملت المعالجة.');
    } catch (err) {
      pushLog(`❌ خطأ فادح: ${err}`);
      console.error(err);
    }
  };

  // ── File Handling ────────────────────────────────────────────────────────────
  const handleFile = (file: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      if (e.target?.result) processBuffer(e.target.result as ArrayBuffer);
    };
    reader.readAsArrayBuffer(file);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  // ── Download ──────────────────────────────────────────────────────────────────
  const downloadJson = () => {
    if (!bundle) return;

    // Serialize to snake_case for Dart compatibility
    const exportObj = {
      version: bundle.version,
      source_system: bundle.sourceSystem,
      exported_at: bundle.exportedAt,
      schema_type: bundle.schemaType,
      currencies: bundle.currencies.map(c => ({
        legacy_id: c.legacyId, legacy_name: c.legacyName,
        mapped_code: c.mappedCode, name_ar: c.nameAr, symbol: c.symbol,
      })),
      groups: bundle.groups.map(g => ({ legacy_id: g.legacyId, name: g.name })),
      customer_types: bundle.customerTypes.map(ct => ({ legacy_id: ct.legacyId, name: ct.name })),
      accounts: bundle.accounts.map(a => ({
        legacy_id: a.legacyId, name: a.name, phone: a.phone,
        group_legacy_id: a.groupLegacyId, group_name: a.groupName,
        customer_type_legacy_id: a.customerTypeLegacyId, customer_type_name: a.customerTypeName,
        balances: a.balances, transaction_count: a.transactionCount,
        classification: a.classification, metadata: a.metadata,
      })),
      transactions: bundle.transactions.map(t => ({
        legacy_id: t.legacyId,
        counterparty_legacy_id: t.counterpartyLegacyId,
        transfer_target_legacy_id: t.transferTargetLegacyId,
        amount_raw: t.amountRaw, type: t.type,
        date: t.date, date_parsed: t.dateParsed,
        description: t.description, currency_code: t.currencyCode,
        metadata: t.metadata,
      })),
      stats: {
        accounts_count: bundle.stats.accountsCount,
        transactions_count: bundle.stats.transactionsCount,
        currencies_count: bundle.stats.currenciesCount,
        groups_count: bundle.stats.groupsCount,
        transfers_count: bundle.stats.transfersCount,
      },
    };

    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qayd_bundle_v2_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setPhase('done');
  };

  const reset = () => {
    setPhase('upload');
    setBundle(null);
    setLog([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const toggleGroup = (gName: string) =>
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.has(gName) ? next.delete(gName) : next.add(gName);
      return next;
    });

  // ── Step Helpers ──────────────────────────────────────────────────────────────
  const currentStep = { upload: 0, analyzing: 1, preview: 2, done: 3 }[phase];

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className={styles.root}>

      {/* ── Stepper ── */}
      <div className={styles.stepper}>
        {STEPS.map((label, i) => (
          <React.Fragment key={i}>
            <div className={`${styles.stepItem} ${i <= currentStep ? styles.stepActive : ''} ${i < currentStep ? styles.stepDone : ''}`}>
              <div className={styles.stepDot}>
                {i < currentStep ? '✓' : <span>{i + 1}</span>}
              </div>
              <span className={styles.stepLabel}>{label}</span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={`${styles.stepConnector} ${i < currentStep ? styles.stepConnectorDone : ''}`} />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* ══ PHASE: Upload ══════════════════════════════════════════════════════ */}
      {phase === 'upload' && (
        <div className={styles.card}>
          <div className={styles.cardBadge}>نظام قيد • وحدة الاستيراد</div>
          <h2 className={styles.cardTitle}>تحويل البيانات من النظام القديم</h2>
          <p className={styles.cardDesc}>
            ارفع ملف قاعدة البيانات (.db) من نظامك السابق. تتمّ المعالجة كاملةً داخل متصفحك — لا يُرسل أيّ بيانات إلى أيّ خادم خارجي.
          </p>

          <div
            id="db-drop-zone"
            className={`${styles.dropZone} ${isDragging ? styles.dropZoneActive : ''}`}
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".db,.sqlite,.sqlite3"
              onChange={handleChange}
              className={styles.hiddenInput}
              id="db-file-upload"
            />
            <div className={styles.dropIcon}>🗄️</div>
            <p className={styles.dropText}>{isDragging ? 'أفلت الملف هنا...' : 'اسحب الملف هنا أو انقر للاختيار'}</p>
            <span className={styles.dropHint}>.db&nbsp;&nbsp;.sqlite&nbsp;&nbsp;.sqlite3</span>
          </div>

          <div className={styles.featureGrid}>
            <div className={styles.featureItem}>
              <span className={styles.featureIcon}>💱</span>
              <span>تحويل ذكي للعملات<br /><small>سعودي → SAR، محلي → YER...</small></span>
            </div>
            <div className={styles.featureItem}>
              <span className={styles.featureIcon}>🗂️</span>
              <span>استيراد المجموعات<br /><small>مع الحفاظ على التصنيف</small></span>
            </div>
            <div className={styles.featureItem}>
              <span className={styles.featureIcon}>🔀</span>
              <span>حركات التحويل<br /><small>بين الحسابات (t_cus_id)</small></span>
            </div>
            <div className={styles.featureItem}>
              <span className={styles.featureIcon}>🔒</span>
              <span>معالجة دون إنترنت<br /><small>بياناتك تبقى على جهازك</small></span>
            </div>
          </div>
        </div>
      )}

      {/* ══ PHASE: Analyzing ══════════════════════════════════════════════════ */}
      {phase === 'analyzing' && (
        <div className={styles.card}>
          <div className={styles.spinnerWrap}>
            <div className={styles.spinner} />
          </div>
          <h2 className={styles.cardTitle}>جاري تحليل قاعدة البيانات...</h2>
          <div className={styles.logBox} id="analysis-log">
            {log.map((entry, i) => (
              <div key={i} className={styles.logLine}>{entry}</div>
            ))}
            <div className={styles.logCursor}>▊</div>
          </div>
        </div>
      )}

      {/* ══ PHASE: Preview ════════════════════════════════════════════════════ */}
      {phase === 'preview' && bundle && (
        <div className={styles.previewWrap}>

          {/* Stats */}
          <div className={styles.statsRow}>
            <div className={styles.statCard}>
              <div className={styles.statEmoji}>👤</div>
              <div className={styles.statNum}>{bundle.stats.accountsCount}</div>
              <div className={styles.statLbl}>حساب</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statEmoji}>📑</div>
              <div className={styles.statNum}>{bundle.stats.transactionsCount}</div>
              <div className={styles.statLbl}>حركة مالية</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statEmoji}>💱</div>
              <div className={styles.statNum}>{bundle.stats.currenciesCount}</div>
              <div className={styles.statLbl}>عملة</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statEmoji}>🔀</div>
              <div className={styles.statNum}>{bundle.stats.transfersCount}</div>
              <div className={styles.statLbl}>تحويل</div>
            </div>
          </div>

          {/* Currency Map */}
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>💱 خريطة تحويل العملات</h3>
            <div className={styles.currTable}>
              <div className={styles.currHeader}>
                <span>الاسم الأصلي</span>
                <span>الكود الدولي</span>
                <span>الاسم بالعربية</span>
                <span>الرمز</span>
              </div>
              {bundle.currencies.map(c => (
                <div key={c.legacyId} className={styles.currRow}>
                  <span className={styles.currOriginal}>{c.legacyName}</span>
                  <span className={styles.currCode}>{c.mappedCode}</span>
                  <span>{c.nameAr}</span>
                  <span className={styles.currSymbol}>{c.symbol}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Accounts by Group */}
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>👤 الحسابات — مُجمَّعة حسب الفئة</h3>
            {(() => {
              const grouped: Record<string, AccountRecord[]> = {};
              for (const acc of bundle.accounts) {
                const key = acc.groupName || 'بدون مجموعة';
                if (!grouped[key]) grouped[key] = [];
                grouped[key].push(acc);
              }
              return Object.entries(grouped).map(([gName, accs]) => (
                <div key={gName} className={styles.groupBlock}>
                  <button
                    className={styles.groupHeader}
                    onClick={() => toggleGroup(gName)}
                    id={`group-${gName.replace(/\s/g, '_')}`}
                  >
                    <span className={styles.groupCaret}>{expandedGroups.has(gName) ? '▾' : '▸'}</span>
                    <span className={styles.groupName}>{gName}</span>
                    <span className={styles.groupPill}>{accs.length}</span>
                  </button>

                  {expandedGroups.has(gName) && (
                    <div className={styles.accountList}>
                      {accs.map(acc => (
                        <div key={acc.legacyId} className={styles.accountRow}>
                          <div className={styles.accountAvatar}>
                            {acc.name.charAt(0) || '؟'}
                          </div>
                          <div className={styles.accountDetails}>
                            <span className={styles.accountName}>{acc.name}</span>
                            {acc.phone && <span className={styles.accountPhone}>{acc.phone}</span>}
                          </div>
                          <div className={styles.accountBadges}>
                            {acc.transactionCount > 0 && (
                              <span className={styles.txBadge}>{acc.transactionCount} حركة</span>
                            )}
                            {acc.balances.map(b => (
                              <span
                                key={b.currencyCode}
                                className={`${styles.balBadge} ${b.balance >= 0 ? styles.balPos : styles.balNeg}`}
                              >
                                {b.balance >= 0 ? '+' : ''}{b.balance.toFixed(2)} {b.currencyCode}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ));
            })()}
          </div>

          {/* Download */}
          <div className={styles.downloadSection}>
            <button id="download-bundle-btn" onClick={downloadJson} className={styles.dlButton}>
              <span>⬇️</span>&nbsp; تحميل حزمة التحويل&nbsp;(JSON v2.0)
            </button>
            <p className={styles.dlHint}>
              افتح تطبيق قيد ← الإعدادات ← استيراد بيانات ← اختر هذا الملف
            </p>
          </div>
        </div>
      )}

      {/* ══ PHASE: Done ═══════════════════════════════════════════════════════ */}
      {phase === 'done' && (
        <div className={styles.card}>
          <div className={styles.successIcon}>✅</div>
          <h2 className={styles.cardTitle}>تم تحميل حزمة التحويل بنجاح!</h2>
          <p className={styles.cardDesc}>الخطوات التالية في تطبيق قيد على هاتفك:</p>
          <ol className={styles.nextList}>
            <li>الإعدادات &gt; <strong>استيراد بيانات</strong></li>
            <li>اختر ملف JSON الذي تم تحميله</li>
            <li>راجع الحسابات المكررة — ادمج أو أنشئ جديداً</li>
            <li>راجع الحركات المالية لكل حساب</li>
            <li>اعتمد السندات (قبض / صرف) المستوردة</li>
          </ol>
          <button id="reset-btn" onClick={reset} className={styles.resetButton}>
            ← استيراد ملف آخر
          </button>
        </div>
      )}
    </div>
  );
};

export default MigrationTool;
