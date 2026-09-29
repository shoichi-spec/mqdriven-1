import React, {
  useEffect,
  useState,
} from 'react';

import type {
  Customer,
  CustomerInfo,
  EmployeeUser,
} from '../../types';

import {
  getCustomerById,
  getCustomerInfo,
  saveCustomerInfo,
  updateCustomer,
} from '../../services/dataService';

interface CustomerInfoFormProps {
  customerId: string | null;
  currentUser?: EmployeeUser | null;
  onSaved?: () => void | Promise<void>;
}

type FinancialForm = {
  capital: string;
  annualSales: string;
  creditLimit: string;
  closingDay: string;
  payDay: string;
  recoveryMethod: string;
};

const EMPTY_FINANCIAL: FinancialForm = {
  capital: '',
  annualSales: '',
  creditLimit: '',
  closingDay: '',
  payDay: '',
  recoveryMethod: '',
};

const inputClass =
  'w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-900 shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100 disabled:text-slate-400';

const textareaClass =
  'w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-900 shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100 disabled:text-slate-400';

const sectionClass =
  'rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8';

const labelClass =
  'mb-2 block text-sm font-semibold text-slate-700';

const CustomerInfoForm: React.FC<
  CustomerInfoFormProps
> = ({
  customerId,
  currentUser,
  onSaved,
}) => {
  const [customer, setCustomer] =
    useState<Customer | null>(null);

  const [info, setInfo] =
    useState<CustomerInfo | null>(null);

  const [
    financial,
    setFinancial,
  ] =
    useState<FinancialForm>(
      EMPTY_FINANCIAL
    );

  const [loading, setLoading] =
    useState(true);

  const [saving, setSaving] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  const [savedMessage, setSavedMessage] =
    useState<string | null>(null);

  const [hasUnsavedChanges, setHasUnsavedChanges] =
    useState(false);

  // 読み込みに失敗した状態で保存すると、空のフォーム内容で既存データを上書きしてしまうため保存を止める
  const [loadFailed, setLoadFailed] =
    useState(false);

  useEffect(() => {
    if (!customerId) {
      setCustomer(null);
      setInfo(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    const loadData = async () => {
      setLoading(true);
      setError(null);
      setSavedMessage(null);
      setLoadFailed(false);

      try {
        const [
          customerResult,
          infoResult,
        ] =
          await Promise.all([
            getCustomerById(
              customerId
            ),
            getCustomerInfo(
              customerId
            ),
          ]);

        if (cancelled) return;

        setCustomer(
          customerResult
        );

        setInfo(
          infoResult
        );

        setHasUnsavedChanges(false);

        setFinancial({
          capital:
            customerResult
              ?.capital != null
              ? String(
                  customerResult.capital
                )
              : '',

          annualSales:
            customerResult
              ?.annualSales != null
              ? String(
                  customerResult.annualSales
                )
              : '',

          creditLimit:
  infoResult
    ?.creditLimit != null
    ? String(
        infoResult.creditLimit
      )
    : '',

          closingDay:
            customerResult
              ?.closingDay != null
              ? String(
                  customerResult.closingDay
                )
              : '',

          payDay:
            customerResult
              ?.payDay != null
              ? String(
                  customerResult.payDay
                )
              : '',

          recoveryMethod:
            customerResult
              ?.recoveryMethod != null
              ? String(
                  customerResult.recoveryMethod
                )
              : '',
        });
      } catch (e) {
        console.error(
          '[CustomerInfoForm] load error:',
          e
        );

        if (cancelled) return;

        setLoadFailed(true);

        setError(
          e instanceof Error
            ? e.message
            : '顧客カルテ情報を取得できませんでした。'
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadData();

    return () => {
      cancelled = true;
    };
  }, [customerId]);

  const handleFinancialChange =
    (
      field: keyof FinancialForm,
      value: string
    ) => {
      setFinancial(
        (prev) => ({
          ...prev,
          [field]: value,
        })
      );

      setSavedMessage(null);
      setHasUnsavedChanges(true);
    };

  const handleInfoChange =
    (
      field: string,
      value: string
    ) => {
      setInfo(
        (prev) => ({
          ...(prev || {}),
          [field]: value,
        })
      );

      setSavedMessage(null);
      setHasUnsavedChanges(true);
    };

  const hasValue = (value: unknown) => {
  if (value === null || value === undefined) return false;

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  return true;
};

const reviewItems = [
  {
    id: 'personInCharge',
    label: '社内担当',
    completed: hasValue(info?.personInCharge),
  },
  {
    id: 'keyPerson',
    label: 'キーパーソン',
    completed: hasValue(info?.keyPerson),
  },
  {
    id: 'customerUnderstanding',
    label: '顧客理解',
    completed:
      hasValue(info?.businessSummary) ||
      hasValue(info?.companyFeatures),
  },
  {
    id: 'needs',
    label: 'ニーズ',
    completed:
      hasValue(info?.needsAndIssues) ||
      hasValue(info?.requirements),
  },
  {
    id: 'business',
    label: '仕事の内容',
    completed:
      hasValue(info?.mainProducts) ||
      hasValue(info?.orderProcess),
  },
  {
    id: 'salesPolicy',
    label: '営業方針',
    completed:
      hasValue(info?.salesTarget) ||
      hasValue(info?.annualActionPlan),
  },
];

const completedReviewCount =
  reviewItems.filter(
    (item) => item.completed
  ).length;

const hasMinimumReviewItems =
  completedReviewCount >= 4;

const canMarkReviewed =
  hasMinimumReviewItems &&
  !hasUnsavedChanges;

  const handleMarkReviewed = async () => {
  if (!customerId) {
    setError('顧客IDがありません。');
    return;
  }

  if (!currentUser?.id) {
    setError('ログインユーザー情報を取得できません。');
    return;
  }

  if (hasUnsavedChanges) {
  setError(
    '入力内容がまだ保存されていません。先に「お客様カルテを保存」を押してください。'
  );
  return;
}

if (!hasMinimumReviewItems) {
  setError(
    'カルテ確認には基本情報が4項目以上必要です。'
  );
  return;
}

  setSaving(true);
  setError(null);
  setSavedMessage(null);

  try {
    const reviewedAt = new Date().toISOString();

    const updatedCustomer =
      await updateCustomer(
        customerId,
        {
          profileReviewed: true,
          profileReviewedAt: reviewedAt,
          profileReviewedBy: currentUser.id,
        }
      );

    setCustomer(updatedCustomer);

    setSavedMessage(
      'お客様カルテを確認済みにしました。'
    );

    await onSaved?.();
  } catch (e) {
    console.error(
      '[CustomerInfoForm] review error:',
      e
    );

    setError(
      e instanceof Error
        ? e.message
        : 'カルテ確認済みの登録に失敗しました。'
    );
  } finally {
    setSaving(false);
  }
};

  const handleSave = async () => {

    if (!customerId) {
      setError(
        '顧客IDがありません。'
      );
      return;
    }

    if (loadFailed) {
      setError(
        '顧客カルテを読み込めなかったため保存できません。画面を再読み込みしてください。'
      );
      return;
    }

    setSaving(true);
    setError(null);
    setSavedMessage(null);

    try {
      /**
       * --------------------------------------------------
       * 1. Financial / Terms
       *    → customers を更新
       * --------------------------------------------------
       */
      const updatedCustomer =
  await updateCustomer(
    customerId,
    {
      capital:
        financial.capital ||
        null,

      annualSales:
        financial.annualSales ||
        null,

      closingDay:
        financial.closingDay ||
        null,

      payDay:
        financial.payDay ||
        null,

      recoveryMethod:
        financial.recoveryMethod ||
        null,
    }
  );

      /**
       * --------------------------------------------------
       * 2. カルテ固有情報
       *    → customers_info を更新
       * --------------------------------------------------
       *
       * Financial系は意図的に除外。
       */
      const infoPayload: Partial<CustomerInfo> =
        {
          creditLimit:
            financial.creditLimit ||
            null,
          
          keyPerson:
            info?.keyPerson ||
            null,

          keyPersonInfo:
            info?.keyPersonInfo ||
            null,

          personInCharge:
            info?.personInCharge ||
            null,

          customerContactInfo:
            info?.customerContactInfo ||
            null,

          businessResult:
            info?.businessResult ||
            null,

          companyFeatures:
            info?.companyFeatures ||
            null,

          customerTrends:
            info?.customerTrends ||
            null,

          salesTrends:
            info?.salesTrends ||
            null,

          companyContent:
            info?.companyContent ||
            null,

          businessSummary:
            info?.businessSummary ||
            null,

          salesTarget:
            info?.salesTarget ||
            null,

          needsAndIssues:
            info?.needsAndIssues ||
            null,

          requirements:
            info?.requirements ||
            null,

          competitors:
            info?.competitors ||
            null,

          competitorInfo:
            info?.competitorInfo ||
            null,

          competitorMeasures:
            info?.competitorMeasures ||
            null,

          incidents:
            info?.incidents ||
            null,

          accidentHistory:
            info?.accidentHistory ||
            null,

          customerVoice:
            info?.customerVoice ||
            null,

          quotationPoints:
            info?.quotationPoints ||
            null,

          orderProcess:
            info?.orderProcess ||
            null,

          mainProducts:
            info?.mainProducts ||
            null,

          externalItems:
            info?.externalItems ||
            null,

          internalItems:
            info?.internalItems ||
            null,

          annualActionPlan:
            info?.annualActionPlan ||
            null,

          lostOrders:
            info?.lostOrders ||
            null,

          growthPotential:
            info?.growthPotential ||
            null,

          orgChart:
            info?.orgChart ||
            null,

          other:
            info?.other ||
            null,

          orderRate:
            info?.orderRate ??
            null,
        };

      const updatedInfo =
        await saveCustomerInfo(
          customerId,
          infoPayload
        );

      setCustomer(
        updatedCustomer
      );

      setInfo(
        updatedInfo
      );

      setHasUnsavedChanges(false);

setSavedMessage(
  'お客様カルテを保存しました。'
);

await onSaved?.();
    } catch (e) {
      console.error(
        '[CustomerInfoForm] save error:',
        e
      );

      setError(
        e instanceof Error
          ? e.message
          : 'お客様カルテの保存に失敗しました。'
      );
    } finally {
      setSaving(false);
    }
  };

  if (!customerId) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
        顧客が選択されていません。
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-[300px] items-center justify-center text-slate-500">
        顧客カルテを読み込んでいます...
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* =====================================================
          Status
      ===================================================== */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {savedMessage && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
          {savedMessage}
        </div>
      )}

      {/* =====================================================
          Record Info
      ===================================================== */}
      <div className="grid grid-cols-1 gap-5 rounded-2xl border border-slate-200 bg-slate-50 p-5 md:grid-cols-3">
        <div>
          <div className="text-xs font-semibold text-slate-500">
            顧客ID
          </div>

          <div className="mt-1 break-all font-medium text-slate-900">
            {customerId}
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-500">
            作成日時
          </div>

          <div className="mt-1 font-medium text-slate-900">
            {info?.createdAt
              ? new Date(
                  String(
                    info.createdAt
                  )
                ).toLocaleString(
                  'ja-JP'
                )
              : '-'}
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-500">
            最終更新
          </div>

          <div className="mt-1 font-medium text-slate-900">
            {info?.updatedAt
              ? new Date(
                  String(
                    info.updatedAt
                  )
                ).toLocaleString(
                  'ja-JP'
                )
              : '-'}
          </div>
        </div>
      </div>

      {/* =====================================================
    Karte Review Status
===================================================== */}
<section className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
  <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
    <div>
      <h3 className="text-lg font-bold text-slate-900">
        カルテ基本情報
      </h3>

      <p className="mt-1 text-sm text-slate-500">
        営業に必要な基本項目の入力状況です。
      </p>
    </div>

    <div className="text-lg font-bold text-slate-900">
      {completedReviewCount} / 6
    </div>
  </div>

  <div className="mt-5 grid grid-cols-1 gap-2 md:grid-cols-2">
    {reviewItems.map((item) => (
      <div
        key={item.id}
        className="flex items-center gap-2 text-sm"
      >
        <span
          className={
            item.completed
              ? 'font-bold text-emerald-600'
              : 'font-bold text-slate-400'
          }
        >
          {item.completed ? '✓' : '－'}
        </span>

        <span
          className={
            item.completed
              ? 'text-slate-900'
              : 'text-slate-500'
          }
        >
          {item.label}
        </span>
      </div>
    ))}
  </div>

  <div className="mt-5 flex flex-col gap-3 border-t border-slate-200 pt-4 md:flex-row md:items-center md:justify-between">
  <div className="text-sm">
    {customer?.profileReviewed ? (
      <div>
        <span className="inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 font-semibold text-emerald-700">
          ✓ カルテ確認済み
        </span>

        {customer.profileReviewedAt && (
          <div className="mt-2 text-xs text-slate-500">
            確認日時：
            {new Date(
              customer.profileReviewedAt
            ).toLocaleString('ja-JP')}
          </div>
        )}
      </div>
    ) : hasUnsavedChanges && hasMinimumReviewItems ? (
  <span className="font-medium text-amber-700">
    入力内容が未保存です。先に「お客様カルテを保存」を押してください。
  </span>
) : canMarkReviewed ? (
  <span className="font-medium text-emerald-700">
    基本情報が揃いました。カルテ確認可能です。
  </span>
) : (
  <span className="text-amber-700">
    あと {Math.max(0, 4 - completedReviewCount)} 項目入力すると確認可能になります。
  </span>
)}
  </div>

  {!customer?.profileReviewed &&
    canMarkReviewed && (
      <button
        type="button"
        onClick={handleMarkReviewed}
        disabled={saving || !currentUser?.id}
        className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving
          ? '処理中...'
          : 'カルテ確認済みにする'}
      </button>
    )}
</div>
</section>

      {/* =====================================================
          Financial / Terms
          customers テーブル
      ===================================================== */}
      <section
        className={
          sectionClass
        }
      >
        <div className="mb-7">
          <h3 className="text-xl font-bold text-slate-900">
            Financial / Terms
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            信用・支払い条件
          </p>

          <p className="mt-2 text-xs text-blue-600">
            ※ この項目は顧客マスタ
            （customers）と共通です。
          </p>
        </div>

        <div className="grid grid-cols-1 gap-x-6 gap-y-6 md:grid-cols-2">
          <div>
            <label
              className={
                labelClass
              }
            >
              資本金
            </label>

            <input
              type="text"
              value={
                financial.capital
              }
              onChange={(e) =>
                handleFinancialChange(
                  'capital',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                inputClass
              }
              placeholder="例：10,000,000"
            />
          </div>

          <div>
            <label
              className={
                labelClass
              }
            >
              年商
            </label>

            <input
              type="text"
              value={
                financial.annualSales
              }
              onChange={(e) =>
                handleFinancialChange(
                  'annualSales',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                inputClass
              }
              placeholder="例：500,000,000"
            />
          </div>

          <div>
            <label
              className={
                labelClass
              }
            >
              与信限度額
            </label>

            <input
              type="text"
              value={
                financial.creditLimit
              }
              onChange={(e) =>
                handleFinancialChange(
                  'creditLimit',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                inputClass
              }
              placeholder="例：5,000,000"
            />
          </div>

          <div>
            <label
              className={
                labelClass
              }
            >
              締日
            </label>

            <input
              type="text"
              value={
                financial.closingDay
              }
              onChange={(e) =>
                handleFinancialChange(
                  'closingDay',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                inputClass
              }
              placeholder="例：月末 / 20"
            />
          </div>

          <div>
            <label
              className={
                labelClass
              }
            >
              支払日
            </label>

            <input
              type="text"
              value={
                financial.payDay
              }
              onChange={(e) =>
                handleFinancialChange(
                  'payDay',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                inputClass
              }
              placeholder="例：翌月15日 / 15"
            />
          </div>

          <div>
            <label
              className={
                labelClass
              }
            >
              支払条件 / サイクル
            </label>

            <input
              type="text"
              value={
                financial.recoveryMethod
              }
              onChange={(e) =>
                handleFinancialChange(
                  'recoveryMethod',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                inputClass
              }
              placeholder="例：月末締め翌月15日払い"
            />
          </div>
        </div>
      </section>

      {/* =====================================================
          Key Person
          customers_info
      ===================================================== */}
      <section
        className={
          sectionClass
        }
      >
        <div className="mb-7">
          <h3 className="text-xl font-bold text-slate-900">
            Key Person / Contact
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            キーパーソン・窓口情報
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <label
              className={
                labelClass
              }
            >
              キーパーソン /
              担当者
            </label>

            <input
              type="text"
              value={
                String(
                  info?.keyPerson ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'keyPerson',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                inputClass
              }
              placeholder="例：営業部 ○○部長"
            />
          </div>

          <div>
            <label
              className={
                labelClass
              }
            >
              社内担当者
            </label>

            <input
              type="text"
              value={
                String(
                  info?.personInCharge ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'personInCharge',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                inputClass
              }
            />
          </div>

          <div className="md:col-span-2">
            <label
              className={
                labelClass
              }
            >
              キーパーソン補足
            </label>

            <textarea
              rows={3}
              value={
                String(
                  info?.keyPersonInfo ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'keyPersonInfo',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
              placeholder="決裁権、連絡時の注意事項など"
            />
          </div>

          <div className="md:col-span-2">
            <label
              className={
                labelClass
              }
            >
              連絡先補足
            </label>

            <textarea
              rows={3}
              value={
                String(
                  info?.customerContactInfo ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'customerContactInfo',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>
        </div>
      </section>

      {/* =====================================================
          Business Profile
      ===================================================== */}
      <section
        className={
          sectionClass
        }
      >
        <div className="mb-7">
          <h3 className="text-xl font-bold text-slate-900">
            Business Profile
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            取引概要・会社特徴
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="md:col-span-2">
            <label
              className={
                labelClass
              }
            >
              取引成績
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.businessResult ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'businessResult',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>

          <div className="md:col-span-2">
            <label
              className={
                labelClass
              }
            >
              会社の特徴
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.companyFeatures ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'companyFeatures',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>

          <div>
            <label
              className={
                labelClass
              }
            >
              顧客動向
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.customerTrends ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'customerTrends',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>

          <div>
            <label
              className={
                labelClass
              }
            >
              営業動向
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.salesTrends ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'salesTrends',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>

          <div className="md:col-span-2">
            <label
              className={
                labelClass
              }
            >
              事業概要
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.businessSummary ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'businessSummary',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>
        </div>
      </section>

      {/* =====================================================
          Sales Strategy
      ===================================================== */}
      <section
        className={
          sectionClass
        }
      >
        <div className="mb-7">
          <h3 className="text-xl font-bold text-slate-900">
            Sales Strategy
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            営業戦略・ニーズ・受注情報
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <label
              className={
                labelClass
              }
            >
              受注率（%）
            </label>

            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={
                info?.orderRate ??
                ''
              }
              onChange={(e) =>
                setInfo(
                  (prev) => ({
                    ...(prev ||
                      {}),
                    orderRate:
                      e.target
                        .value ===
                      ''
                        ? null
                        : Number(
                            e.target
                              .value
                          ),
                  })
                )
              }
              disabled={saving}
              className={
                inputClass
              }
            />
          </div>

          <div>
            <label
              className={
                labelClass
              }
            >
              営業目標
            </label>

            <input
              type="text"
              value={
                String(
                  info?.salesTarget ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'salesTarget',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                inputClass
              }
            />
          </div>

          <div className="md:col-span-2">
            <label
              className={
                labelClass
              }
            >
              ニーズ・課題
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.needsAndIssues ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'needsAndIssues',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>

          <div className="md:col-span-2">
            <label
              className={
                labelClass
              }
            >
              要求事項
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.requirements ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'requirements',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>

          <div>
            <label
              className={
                labelClass
              }
            >
              見積時のポイント
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.quotationPoints ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'quotationPoints',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>

          <div>
            <label
              className={
                labelClass
              }
            >
              受注プロセス
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.orderProcess ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'orderProcess',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>

          <div className="md:col-span-2">
            <label
              className={
                labelClass
              }
            >
              主力商品・案件
            </label>

            <textarea
              rows={3}
              value={
                String(
                  info?.mainProducts ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'mainProducts',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>
        </div>
      </section>

      {/* =====================================================
          Competition / Risk
      ===================================================== */}
      <section
        className={
          sectionClass
        }
      >
        <div className="mb-7">
          <h3 className="text-xl font-bold text-slate-900">
            Competition / Risk
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            競合・事故・リスク情報
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <label
              className={
                labelClass
              }
            >
              競合先
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.competitors ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'competitors',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>

          <div>
            <label
              className={
                labelClass
              }
            >
              競合情報
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.competitorInfo ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'competitorInfo',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>

          <div className="md:col-span-2">
            <label
              className={
                labelClass
              }
            >
              競合対策
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.competitorMeasures ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'competitorMeasures',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>

          <div>
            <label
              className={
                labelClass
              }
            >
              トラブル・事故
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.incidents ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'incidents',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>

          <div>
            <label
              className={
                labelClass
              }
            >
              事故履歴
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.accidentHistory ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'accidentHistory',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>
        </div>
      </section>

      {/* =====================================================
          Other
      ===================================================== */}
      <section
        className={
          sectionClass
        }
      >
        <div className="mb-7">
          <h3 className="text-xl font-bold text-slate-900">
            Notes
          </h3>

          <p className="mt-1 text-sm text-slate-500">
            その他の顧客情報
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <label
              className={
                labelClass
              }
            >
              お客様の声
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.customerVoice ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'customerVoice',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>

          <div>
            <label
              className={
                labelClass
              }
            >
              成長可能性
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.growthPotential ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'growthPotential',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>

          <div className="md:col-span-2">
            <label
              className={
                labelClass
              }
            >
              年間行動計画
            </label>

            <textarea
              rows={4}
              value={
                String(
                  info?.annualActionPlan ??
                    ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'annualActionPlan',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>

          <div className="md:col-span-2">
            <label
              className={
                labelClass
              }
            >
              その他
            </label>

            <textarea
              rows={5}
              value={
                String(
                  info?.other ?? ''
                )
              }
              onChange={(e) =>
                handleInfoChange(
                  'other',
                  e.target.value
                )
              }
              disabled={saving}
              className={
                textareaClass
              }
            />
          </div>
        </div>
      </section>

      {/* =====================================================
          Save
      ===================================================== */}
      <div className="sticky bottom-4 flex justify-end">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || loadFailed}
          className="rounded-xl bg-blue-600 px-8 py-3 font-bold text-white shadow-lg transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving
            ? '保存中...'
            : 'お客様カルテを保存'}
        </button>
      </div>
    </div>
  );
};

export default CustomerInfoForm;
