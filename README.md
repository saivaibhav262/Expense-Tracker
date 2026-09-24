# Expense-Tracker
# 💰 Personal Expense Tracker

A responsive **full-stack web application** for managing personal expenses with user authentication, cloud synchronization, offline support, reports, and data backup.

## 🚀 Live Demo

🔗 **Live Application:**  
https://saivaibhav262.github.io/Expense-Tracker/

## 📌 Overview

Personal Expense Tracker is a browser-based expense management application designed to help users record, organize, analyze, and back up their daily expenses.

The application combines **LocalStorage** for offline persistence with **Supabase** for authentication and cloud database storage. This allows users to continue managing expenses even without an internet connection and synchronize their data when connectivity is restored.

## ✨ Features

- 🔐 User authentication with Supabase
- 👤 User-specific expense data
- ➕ Add new expenses
- ✏️ Edit existing expenses
- 🗑️ Delete expenses using soft deletion
- 📊 Monthly and category-based expense summaries
- 📅 Filter expenses by:
  - Date
  - Month
  - Year
  - Custom date range
  - All available records
- 📄 Export reports as CSV
- 🖨️ Generate PDF reports
- 💾 JSON backup and restore
- 📦 LocalStorage-based offline persistence
- ☁️ Automatic cloud synchronization
- 🔄 Local-to-cloud data synchronization
- ⚡ Offline-first workflow
- 🛡️ Supabase Row Level Security (RLS)
- ✅ Input and backup data validation
- 🔀 Timestamp-based conflict handling
- 📱 Responsive user interface

## 🛠️ Technologies Used

### Frontend
- HTML5
- CSS3
- JavaScript (ES6+)

### Backend / Cloud
- Supabase
- PostgreSQL
- Supabase Authentication
- Row Level Security (RLS)

### Browser Storage
- LocalStorage

### Other
- Git
- GitHub
- GitHub Pages

## 🏗️ Application Architecture

```text
                ┌──────────────────────┐
                │       User           │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │   HTML / CSS / JS    │
                │      Frontend        │
                └──────────┬───────────┘
                           │
                ┌──────────┴───────────┐
                │                      │
                ▼                      ▼
       ┌────────────────┐    ┌──────────────────┐
       │  LocalStorage  │    │     Supabase     │
       │                │    │                  │
       │ Offline Data   │◄──►│ Authentication   │
       │ Local Changes  │    │ PostgreSQL DB    │
       └────────────────┘    │ RLS Policies     │
                             └──────────────────┘
