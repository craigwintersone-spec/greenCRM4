// js/config.js — global constants, Supabase keys, enumerations
// Loaded first. No dependencies.

'use strict';

// ── Supabase ──────────────────────────────────────────────────
const SB_URL = 'https://nznfrxzgvcjhfsdaphyp.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56bmZyeHpndmNqaGZzZGFwaHlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MjQzNzcsImV4cCI6MjA5MjQwMDM3N30.vDlv1aVF4MlXPJ_VCWvyWWYYqovwJxUvNnwwUgYXSyw';

// ── Claude (AI) ───────────────────────────────────────────────
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const AI_PLANS = ['pro', 'network'];
const AI_MIN_GAP_MS = 1500;

// ── Domain enumerations ──────────────────────────────────────
const BARRIERS = [
  'Housing', 'Confidence', 'Skills gap', 'Transport', 'Childcare',
  'Mental health', 'Substance misuse', 'Criminal record', 'Language',
  'Benefits', 'Disability', 'Financial'
];

const OUT_TYPES = [
  'Employment', 'Training', 'Qualification', 'Volunteering',
  'Wellbeing', 'Housing secured'
];

const P_STAGES = [
  'Referred', 'Engaged', 'In Support', 'Job Ready',
  'Outcome Achieved', 'Sustained', 'Closed'
];

const VOL_SKILLS = [
  'Gardening', 'Composting', 'Cooking', 'Teaching/Facilitation',
  'Photography', 'Social Media', 'Admin/Office', 'Driving',
  'Event Setup', 'Fundraising', 'Bike repair', 'Electrical',
  'Sewing/Textiles', 'Other'
];

// Modules controllable from Settings
const SET_MODULES = [
  { k: 'participants', n: 'Participants & Caseload', d: 'Pipeline, referrals, outcomes, safeguarding' },
  { k: 'volunteers',   n: 'Volunteers & Staff',      d: 'Registration, onboarding, hours tracking' },
  { k: 'events',       n: 'Events & Feedback',       d: 'Workshops, feedback surveys, impact wall' },
  { k: 'employers',    n: 'Employers',               d: 'Employer CRM, vacancies, placements' },
  { k: 'circular',     n: 'Circular Economy',        d: 'Repair café, item logging, CO2 tracking' },
  { k: 'funders',      n: 'Funders & Reporting',     d: 'Contracts, RAG dashboard, funder reports' }
];

// Funder type labels — used in Funders page
const FUNDER_TYPES = {
  moj:     { label: 'Ministry of Justice',     icon: '⚖️' },
  gla:     { label: 'Greater London Authority', icon: '🏙️' },
  cbf:     { label: 'City Bridge Foundation',   icon: '🌉' },
  ukspf:   { label: 'UKSPF',                    icon: '🏛️' },
  lottery: { label: 'National Lottery',         icon: '🍀' },
  trust:   { label: 'Grant trust',              icon: '🎗️' },
  dwp:     { label: 'DWP',                      icon: '💼' },
  nhs:     { label: 'NHS',                      icon: '🏥' },
  impact:  { label: 'Annual report',            icon: '🌿' },
  other:   { label: 'Other',                    icon: '📋' }
};

// Brand colour palette for the first-login branding modal
const BRAND_COLOURS = [
  { hex: '#1F6F6D', name: 'Civara teal' },
  { hex: '#175655', name: 'Deep teal' },
  { hex: '#2A9D8F', name: 'Sea green' },
  { hex: '#0EA5E9', name: 'Sky' },
  { hex: '#6366F1', name: 'Indigo' },
  { hex: '#7C3AED', name: 'Violet' },
  { hex: '#EC4899', name: 'Pink' },
  { hex: '#F59E0B', name: 'Amber' },
  { hex: '#EF4444', name: 'Red' },
  { hex: '#10B981', name: 'Emerald' },
  { hex: '#0F766E', name: 'Forest' },
  { hex: '#1E293B', name: 'Slate' }
];
