import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../OrgAuthContext';

export default function TrialBanner() {
  const { organization, subscriptionStatus } = useAuth();

  // Only show during trial
  if (!organization || organization.plan !== 'trial') return null;

  const daysLeft = subscriptionStatus?.trialDaysRemaining ?? 0;

  // Show banner only in last 3 days OR when expired but in grace period
  const isExpired = organization.status === 'trial_expired';
  const showWarning = daysLeft >= 0 && daysLeft <= 3;

  if (!showWarning && !isExpired) return null;

  // Calculate grace days remaining if expired
  let graceDaysLeft = 0;
  if (isExpired && organization.gracePeriodEndsAt) {
    const ms = organization.gracePeriodEndsAt - Date.now();
    graceDaysLeft = Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  }

  const bgColor = isExpired ? '#c62828' : (daysLeft <= 1 ? '#e65100' : '#f57c00');
  const message = isExpired
    ? `Your trial has ended. Your data is safe for ${graceDaysLeft} more days. Upgrade to keep using SkidSling.`
    : daysLeft === 0
      ? `Your trial ends today. Upgrade now to keep your data and continue using SkidSling.`
      : daysLeft === 1
        ? `Your trial ends tomorrow. Upgrade now to keep your data and avoid losing access.`
        : `Your trial ends in ${daysLeft} days. Upgrade to keep your data and continue using SkidSling.`;

  return (
    <div style={{
      background: bgColor,
      color: 'white',
      padding: '10px 20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16,
      fontSize: 14,
      fontWeight: 500,
      borderBottom: '1px solid rgba(0,0,0,0.15)'
    }}>
      <span style={{ fontSize: 18 }}>{isExpired ? '⏱️' : '⚠️'}</span>
      <span>{message}</span>
      <Link
        to="/subscription-required"
        style={{
          background: 'rgba(255,255,255,0.95)',
          color: bgColor,
          padding: '6px 14px',
          borderRadius: 4,
          textDecoration: 'none',
          fontWeight: 700,
          fontSize: 13,
          letterSpacing: 0.3
        }}
      >
        {isExpired ? 'Restore Access' : 'Upgrade Now'}
      </Link>
      {isExpired && (
        <Link
          to="/export-data"
          style={{
            color: 'rgba(255,255,255,0.9)',
            textDecoration: 'underline',
            fontSize: 13
          }}
        >
          Export my data
        </Link>
      )}
    </div>
  );
}
