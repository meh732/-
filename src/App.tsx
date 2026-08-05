import React, { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { Bot, Upload, Settings, List, Save, Play, Square, Server, CheckCircle2, AlertCircle, Info, Users, Plus, Edit, Trash, FileDown, DownloadCloud } from 'lucide-react';
import type { AppState, BotConfig, InventoryItem, CustomerRequest } from './types';

const normalizePersianArabicNumbers = (str: string): string => {
  const persianNumbers = [/۰/g, /۱/g, /۲/g, /۳/g, /۴/g, /۵/g, /۶/g, /۷/g, /۸/g, /۹/g];
  const arabicNumbers  = [/٠/g, /١/g, /٢/g, /٣/g, /٤/g, /٥/g, /٦/g, /٧/g, /٨/g, /٩/g];
  let res = str;
  for (let i = 0; i < 10; i++) {
    res = res.replace(persianNumbers[i], String(i)).replace(arabicNumbers[i], String(i));
  }
  res = res.replace(/ي/g, "ی").replace(/ك/g, "ک");
  return res;
};

const sanitizeCode = (code: string | undefined | null): string => {
  if (!code) return "";
  const normalized = normalizePersianArabicNumbers(String(code));
  return normalized.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '').toLowerCase();
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'settings' | 'inventory' | 'customers'>('settings');
  const [state, setState] = useState<AppState>({
    config: { token: '', adminId: '', groupId: '', customerMessage: '', groupAccess: 'all' },
    inventory: [],
    customers: [],
    isRunning: false,
    groups: []
  });
  const [config, setConfig] = useState<BotConfig>({
    token: '',
    adminId: '',
    groupId: '',
    customerMessage: '',
    groupAccess: 'all',
    botEnabled: true,
    disableCustomerPm: false,
    userbotApiId: '',
    userbotApiHash: '',
    userbotSession: '',
    userbotEnabled: false,
    userbotGroups: ''
  });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ text: string, type: 'success' | 'error' } | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  // States for interactive Userbot registration & configuration
  const [userbotPhone, setUserbotPhone] = useState('');
  const [userbotApiIdInput, setUserbotApiIdInput] = useState('');
  const [userbotApiHashInput, setUserbotApiHashInput] = useState('');
  const [userbotStep, setUserbotStep] = useState<'request_code' | 'verify_code'>('request_code');
  const [userbotCodeInput, setUserbotCodeInput] = useState('');
  const [userbot2FaInput, setUserbot2FaInput] = useState('');
  const [userbotStatusMsg, setUserbotStatusMsg] = useState('');
  const [userbotIsConnecting, setUserbotIsConnecting] = useState(false);
  const [userbotUseBypass, setUserbotUseBypass] = useState(true);
  const [userbotSentCodeType, setUserbotSentCodeType] = useState<string | null>(null);
  const [userbotEmailPattern, setUserbotEmailPattern] = useState<string | null>(null);
  const [userbotCodeLength, setUserbotCodeLength] = useState<number | null>(null);

  // Userbot Dialogs selection states
  const [dialogGroups, setDialogGroups] = useState<Array<{ id: string, title: string, username?: string, isChannel?: boolean }>>([]);
  const [isLoadingDialogs, setIsLoadingDialogs] = useState(false);
  const [dialogSearch, setDialogSearch] = useState('');

  // States for manual product entry
  const [manualCode, setManualCode] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualStock, setManualStock] = useState('');
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    fetchState();
  }, []);

  const fetchDialogGroups = async () => {
    setIsLoadingDialogs(true);
    try {
      const res = await fetch('/api/userbot/dialogs');
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.groups) {
          setDialogGroups(data.groups);
        }
      }
    } catch (err) {
      console.error("Failed to load userbot dialogs:", err);
    } finally {
      setIsLoadingDialogs(false);
    }
  };

  const handleToggleGroup = (groupId: string) => {
    const currentGroups = config.userbotGroups
      ? config.userbotGroups.split(',').map(x => x.trim()).filter(Boolean)
      : [];
    
    let updated: string[];
    if (currentGroups.includes(groupId)) {
      updated = currentGroups.filter(g => g !== groupId);
    } else {
      updated = [...currentGroups, groupId];
    }
    
    setConfig(prev => ({
      ...prev,
      userbotGroups: updated.join(', ')
    }));
  };

  const fetchState = async () => {
    try {
      const res = await fetch('/api/state');
      const data: AppState = await res.json();
      
      let needsRestore = false;
      let restoredConfig = data.config;

      // 1. Auto-restore configuration if container restarted and wiped state on ephemeral container disk
      if (!data.config?.token || !data.config?.adminId) {
        const backupStr = localStorage.getItem('bot_config_backup');
        if (backupStr) {
          try {
            const backupConfig = JSON.parse(backupStr);
            if (backupConfig.token && backupConfig.adminId) {
              console.log("Restoring bot configuration from browser localStorage backup...");
              const restoreRes = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(backupConfig),
              });
              if (restoreRes.ok) {
                restoredConfig = backupConfig;
                needsRestore = true;
              }
            }
          } catch (e) {
            console.error("Failed to restore config backup from localStorage", e);
          }
        }
      } else {
        // We have valid server-side config. Store it in localStorage as a backup
        localStorage.setItem('bot_config_backup', JSON.stringify(data.config));
      }

      // 2. Auto-restore inventory if empty and we have a valid config token
      if ((!data.inventory || data.inventory.length === 0) && restoredConfig?.token) {
        const backupInvStr = localStorage.getItem('bot_inventory_backup');
        if (backupInvStr) {
          try {
            const backupInv = JSON.parse(backupInvStr);
            if (Array.isArray(backupInv) && backupInv.length > 0) {
              console.log("Restoring inventory from browser localStorage backup...");
              const restoreInvRes = await fetch('/api/inventory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(backupInv),
              });
              if (restoreInvRes.ok) {
                needsRestore = true;
              }
            }
          } catch (e) {
            console.error("Failed to restore inventory backup from localStorage", e);
          }
        }
      } else if (data.inventory && data.inventory.length > 0) {
        // We have valid server-side inventory. Store it in localStorage as a backup
        localStorage.setItem('bot_inventory_backup', JSON.stringify(data.inventory));
      }

      // 3. Auto-restore customers if empty
      if ((!data.customers || data.customers.length === 0) && restoredConfig?.token) {
        const backupCustStr = localStorage.getItem('bot_customers_backup');
        if (backupCustStr) {
          try {
            const backupCust = JSON.parse(backupCustStr);
            if (Array.isArray(backupCust) && backupCust.length > 0) {
              console.log("Restoring customers from browser localStorage backup...");
              const restoreCustRes = await fetch('/api/customers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(backupCust),
              });
              if (restoreCustRes.ok) {
                needsRestore = true;
              }
            }
          } catch (e) {
            console.error("Failed to restore customers backup from localStorage", e);
          }
        }
      } else if (data.customers && data.customers.length > 0) {
        // We have valid server-side customers. Store it in localStorage as a backup
        localStorage.setItem('bot_customers_backup', JSON.stringify(data.customers));
      }

      if (needsRestore) {
        // Re-fetch state once restore triggers complete
        setTimeout(() => {
          fetchState();
        }, 150);
        return;
      }

      setState(data);
      
      const loadedApiId = data.config?.userbotApiId || '';
      const loadedApiHash = data.config?.userbotApiHash || '';
      
      setUserbotApiIdInput(loadedApiId);
      setUserbotApiHashInput(loadedApiHash);

      setConfig({
        token: data.config?.token || '',
        adminId: data.config?.adminId || '',
        groupId: data.config?.groupId || '',
        customerMessage: data.config?.customerMessage || '',
        groupAccess: data.config?.groupAccess || 'all',
        botEnabled: data.config?.botEnabled !== false,
        disableCustomerPm: !!data.config?.disableCustomerPm,
        userbotApiId: loadedApiId,
        userbotApiHash: loadedApiHash,
        userbotSession: data.config?.userbotSession || '',
        userbotEnabled: data.config?.userbotEnabled !== false,
        userbotGroups: data.config?.userbotGroups || ''
      });

      if (data.config?.userbotSession) {
        // Fetch groups list on mount if already has session
        setTimeout(() => {
          fetchDialogGroups();
        }, 100);
      }
    } catch (err) {
      console.error(err);
      showMessage('خطا در دریافت اطلاعات از سرور', 'error');
    } finally {
      setLoading(false);
    }
  };

  const showMessage = (text: string, type: 'success' | 'error') => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 3000);
  };

  const downloadSampleExcel = () => {
    try {
      const wb = XLSX.utils.book_new();
      const sheetData = [
        ["کد", "نام", "موجودی"],
        ["SH-101", "تیشرت مشکی مردانه", "15"],
        ["SH-102", "شلوار جین آبی", "5"],
        ["SH-103", "کفش ورزشی سفید (موجودی صفر یعنی ناموجود)", "0"],
        ["SH-104", "جوراب نخی (نام اختیاری - بدون موجودی یعنی موجود)", ""]
      ];
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      XLSX.utils.book_append_sheet(wb, ws, "Inventory_Template");
      XLSX.writeFile(wb, "Inventory_Sample_Template.xlsx");
      showMessage('فایل نمونه اکسل با موفقیت دانلود شد', 'success');
    } catch (err) {
      showMessage('خطا در ایجاد و دانلود فایل نمونه', 'error');
    }
  };

  const handleAddOrUpdateManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim()) {
      showMessage('کد کالا الزامی است', 'error');
      return;
    }
    
    if (!state) return;
    
    const formattedCode = manualCode.trim();
    const formattedName = manualName.trim() || 'بدون نام';
    const formattedStock = manualStock.trim() === '' ? 1 : Number(manualStock);

    let updatedInventory = [...(state.inventory || [])];
    const existingIndex = updatedInventory.findIndex(item => sanitizeCode(item.code) === sanitizeCode(formattedCode));

    if (existingIndex !== -1) {
      // Update existing
      updatedInventory[existingIndex] = {
        code: formattedCode,
        name: formattedName,
        stock: formattedStock
      };
      showMessage('کالا با موفقیت بروزرسانی شد', 'success');
    } else {
      // Add new
      updatedInventory.push({
        code: formattedCode,
        name: formattedName,
        stock: formattedStock
      });
      showMessage('کالا جدید با موفقیت اضافه شد', 'success');
    }

    try {
      const res = await fetch('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedInventory),
      });
      if (res.ok) {
        setState(prev => ({ ...prev, inventory: updatedInventory }));
        localStorage.setItem('bot_inventory_backup', JSON.stringify(updatedInventory));
        setManualCode('');
        setManualName('');
        setManualStock('');
        setIsEditing(false);
      } else {
         showMessage('خطا در همگام‌سازی با سرور', 'error');
      }
    } catch (err) {
       showMessage('خطا در ذخیره کالای جدید', 'error');
    }
  };

  const handleDeleteItem = async (codeToDelete: string) => {
    if (!state) return;
    if (!window.confirm('آیا از حذف این کالا اطمینان دارید؟')) return;

    const querySanitized = sanitizeCode(codeToDelete);
    const updatedInventory = (state.inventory || []).filter(item => {
      return item.code !== codeToDelete && sanitizeCode(item.code) !== querySanitized && sanitizeCode(item.name) !== querySanitized;
    });

    try {
      const res = await fetch('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedInventory),
      });
      if (res.ok) {
        setState(prev => ({ ...prev, inventory: updatedInventory }));
        localStorage.setItem('bot_inventory_backup', JSON.stringify(updatedInventory));
        showMessage('کالا با موفقیت حذف شد', 'success');
      } else {
        showMessage('خطا در بروزرسانی لیست کالاها روی هاست', 'error');
      }
    } catch (err) {
      showMessage('خطا در برقراری ارتباط با سرور', 'error');
    }
  };

  const handleSelectForEdit = (item: InventoryItem) => {
    setManualCode(String(item.code || ''));
    setManualName(item.name === 'بدون نام' ? '' : item.name);
    setManualStock(String(item.stock));
    setIsEditing(true);
  };

  const handleSaveConfig = async () => {
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      setState(prev => prev ? { ...prev, config, isRunning: data.isRunning } : null);
      showMessage('تنظیمات با موفقیت ذخیره شد!', 'success');
    } catch (err) {
      showMessage('خطا در ذخیره تنظیمات', 'error');
    }
  };

  const handleUserbotSendCode = async () => {
    if (!userbotPhone) {
      showMessage('لطفاً شماره تلفن اکانت تلگرام را وارد کنید.', 'error');
      return;
    }
    if (!userbotUseBypass && (!userbotApiIdInput || !userbotApiHashInput)) {
      showMessage('لطفاً آیدی API و هش API را وارد کنید یا گزینه اتصال سریع را فعال نمایید.', 'error');
      return;
    }
    setUserbotIsConnecting(true);
    setUserbotStatusMsg('درحال ارسال کد تایید...');
    setUserbotSentCodeType(null);
    setUserbotEmailPattern(null);
    setUserbotCodeLength(null);
    try {
      const res = await fetch('/api/userbot/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiId: userbotUseBypass ? "" : userbotApiIdInput.trim(),
          apiHash: userbotUseBypass ? "" : userbotApiHashInput.trim(),
          phoneNumber: userbotPhone.trim()
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setUserbotStep('verify_code');
        
        let destinationMsg = 'کد تایید تلگرام با موفقیت ارسال شد. لطفاً آن را وارد کنید.';
        if (data.sentCodeType === 'auth.SentCodeTypeEmailCode') {
          destinationMsg = `یک کد تایید ${data.codeLength || '۵'} رقمی به آدرس ایمیل شما (${data.emailPattern || 'مربوطه'}) ارسال شده است. لطفاً صندوق ورودی (Inbox) یا هرزنامه (Spam) ایمیل خود را بررسی کنید.`;
        } else if (data.sentCodeType === 'auth.SentCodeTypeSetUpEmailRequired') {
          destinationMsg = 'تایید یا اتصال آدرس ایمیل برای ورود به این حساب در تلگرام الزامی است.';
        } else if (data.sentCodeType === 'auth.SentCodeTypeApp') {
          destinationMsg = 'کد تایید به اپلیکیشن تلگرام فعال شما ارسال شد. لطفاً آن را در کادر زیر وارد کنید.';
        } else if (data.sentCodeType === 'auth.SentCodeTypeSms') {
          destinationMsg = 'کد تایید به صورت پیامک (SMS) برای شما ارسال شد. لطفاً آن را در کادر زیر وارد کنید.';
        }
        
        setUserbotStatusMsg(destinationMsg);
        setUserbotSentCodeType(data.sentCodeType || null);
        setUserbotEmailPattern(data.emailPattern || null);
        setUserbotCodeLength(data.codeLength || null);
        showMessage('کد تایید با موفقیت ارسال شد!', 'success');
      } else {
        setUserbotStatusMsg(data.error || 'خطا در ارسال کد تایید');
        showMessage(data.error || 'خطا در ارسال کد تایید', 'error');
      }
    } catch (e) {
      setUserbotStatusMsg('خطا در برقراری ارتباط با سرور.');
      showMessage('خطا در برقراری ارتباط', 'error');
    } finally {
      setUserbotIsConnecting(false);
    }
  };

  const handleUserbotVerifyCode = async () => {
    if (!userbotCodeInput) {
      showMessage('لطفاً کد تایید را وارد کنید.', 'error');
      return;
    }
    setUserbotIsConnecting(true);
    setUserbotStatusMsg('در حال تایید کد و اتصال به تلگرام...');
    try {
      const res = await fetch('/api/userbot/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: userbotPhone.trim(),
          code: userbotCodeInput.trim(),
          password: userbot2FaInput.trim() || undefined
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showMessage('ربات کاربری با موفقیت فعال شد!', 'success');
        setUserbotStatusMsg('');
        setUserbotStep('request_code');
        setUserbotCodeInput('');
        setUserbot2FaInput('');
        fetchState();
      } else if (data.requiresPassword) {
        setUserbotStatusMsg('اکانت شما دارای تایید دو مرحله‌ای است. لطفاً گذرواژه ابری خود را وارد کنید.');
        showMessage('تایید دو مرحله‌ای الزامی است.', 'error');
      } else {
        setUserbotStatusMsg(data.error || 'کد تایید نامعتبر است.');
        showMessage(data.error || 'خطا در تایید کد', 'error');
      }
    } catch (e) {
      setUserbotStatusMsg('خطا در اتصال به سرور.');
      showMessage('خطا در تایید کد تایید', 'error');
    } finally {
      setUserbotIsConnecting(false);
    }
  };

  const handleUserbotLogout = async () => {
    if (!window.confirm('آیا مطمئن هستید که می‌خواهید ربات کاربری (سلف) را قطع اتصال کنید؟')) {
      return;
    }
    try {
      const res = await fetch('/api/userbot/logout', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        showMessage('ربات کاربر با موفقیت قطع اتصال شد.', 'success');
        fetchState();
      } else {
        showMessage('خطا در قطع اتصال', 'error');
      }
    } catch (e) {
      showMessage('خطا در اتصال به سرور', 'error');
    }
  };

  const toggleBot = async () => {
    if (!state) return;
    const action = state.isRunning ? 'stop' : 'start';
    try {
      const res = await fetch(`/api/bot/${action}`, { method: 'POST' });
      const data = await res.json();
      setState(prev => prev ? { ...prev, isRunning: data.isRunning } : null);
      showMessage(data.isRunning ? 'ربات روشن شد' : 'ربات خاموش شد', 'success');
    } catch (err) {
      showMessage('خطا در تغییر وضعیت ربات', 'error');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        
        // Convert to array of arrays first to map correctly
        const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
        if (data.length < 2) throw new Error("فایل اکسل خالی است یا فرمت مناسبی ندارد");
        
        // Find column indices
        const headers = data[0].map((h: string) => h?.toString().toLowerCase().trim());
        const codeIdx = headers.findIndex(h => h === 'کد' || h === 'code');
        const nameIdx = headers.findIndex(h => h === 'نام' || h === 'name' || h === 'title' || h === 'عنوان');
        const stockIdx = headers.findIndex(h => h === 'موجودی' || h === 'stock' || h === 'qty' || h === 'تعداد');

        if (codeIdx === -1) {
          throw new Error("ستون 'کد' (یا code) در ردیف اول فایل اکسل پیدا نشد.");
        }

        const existingInventory = [...(state.inventory || [])];
        let addedCount = 0;
        let updatedCount = 0;

        for (let i = 1; i < data.length; i++) {
          const row = data[i];
          if (!row || row.length === 0 || !row[codeIdx]) continue;
          
          const rawCode = String(row[codeIdx]).trim();
          const rawName = nameIdx !== -1 && row[nameIdx] ? String(row[nameIdx]).trim() : 'بدون نام';
          
          let itemStock = 1;
          if (stockIdx !== -1 && row[stockIdx] !== undefined && row[stockIdx] !== null && String(row[stockIdx]).trim() !== "") {
            const numValue = Number(row[stockIdx]);
            itemStock = isNaN(numValue) ? 0 : numValue;
          }

          const sanitizedInputCode = sanitizeCode(rawCode);
          const existingIdx = existingInventory.findIndex(item => sanitizeCode(item.code) === sanitizedInputCode);

          if (existingIdx !== -1) {
            existingInventory[existingIdx] = {
              code: rawCode,
              name: rawName !== 'بدون نام' ? rawName : existingInventory[existingIdx].name,
              stock: itemStock
            };
            updatedCount++;
          } else {
            existingInventory.push({
              code: rawCode,
              name: rawName,
              stock: itemStock
            });
            addedCount++;
          }
        }

        // Send the updated merged inventory to the server
        const res = await fetch('/api/inventory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(existingInventory),
        });
        
        if (res.ok) {
          setState(prev => prev ? ({ ...prev, inventory: existingInventory }) : null);
          showMessage(`همگام‌سازی اکسل با انبار موفقیت‌آمیز بود! تعداد ${addedCount} کالا اضافه و ${updatedCount} کالا بروزرسانی شد.`, 'success');
        } else {
          throw new Error("خطا در ذخیره در سرور");
        }
      } catch (err: any) {
        showMessage(err.message || 'خطا در پردازش فایل اکسل', 'error');
      } finally {
        setIsUploading(false);
        // Reset input
        e.target.value = '';
      }
    };
    reader.onerror = () => {
      showMessage('خطا در خواندن فایل', 'error');
      setIsUploading(false);
    };
    reader.readAsBinaryString(file);
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-gray-50 text-gray-800" dir="rtl"><span className="text-xl">در حال بارگذاری...</span></div>;
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans" dir="rtl">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 py-4 flex flex-col sm:flex-row gap-4 items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center text-white">
              <Bot size={24} />
            </div>
            <div>
              <h1 className="text-xl font-bold">پنل ربات دستیار MEH tel:@mohammadeh7</h1>
              <span className={`text-sm flex items-center gap-1 mt-1 ${state?.isRunning ? 'text-green-600' : 'text-red-500'}`}>
                {state?.isRunning ? <CheckCircle2 size={14}/> : <AlertCircle size={14}/>}
                {state?.isRunning ? 'ربات در حال اجرا است' : 'ربات خاموش است'}
              </span>
            </div>
          </div>
          
          {/* Status Controls */}
          <div className="flex items-center gap-3">
            <button 
              onClick={toggleBot}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg text-white transition-colors
                ${state?.isRunning ? 'bg-red-500 hover:bg-red-600' : 'bg-green-600 hover:bg-green-700'}
              `}
            >
              {state?.isRunning ? <Square size={16} className="fill-current" /> : <Play size={16} className="fill-current" />}
              {state?.isRunning ? 'توقف ربات' : 'اجرای ربات'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        
        {message && (
          <div className={`mb-6 p-4 rounded-lg flex items-center gap-3 ${message.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
            {message.type === 'success' ? <CheckCircle2 size={20}/> : <AlertCircle size={20}/>}
            {message.text}
          </div>
        )}

        {/* Custom Tabs */}
        <div className="flex flex-wrap gap-2.5 mb-8">
          {[
            { id: 'settings', icon: Settings, label: 'تنظیمات ربات' },
            { id: 'inventory', icon: List, label: 'موجودی کالاها' },
            { id: 'customers', icon: Users, label: 'مشتریان' }
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-full font-bold text-sm transition-all shadow-xs cursor-pointer
                ${activeTab === tab.id 
                  ? 'bg-blue-600 text-white shadow-sm' 
                  : 'bg-gray-100 hover:bg-gray-200 text-gray-600'
                }
              `}
            >
              <tab.icon size={18} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          
          {activeTab === 'settings' && (
            <div className="p-6">
              {/* Bot status card */}
              <div className="mb-8 bg-gray-50 border border-gray-200 rounded-xl p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                  <h3 className="font-bold text-gray-800 flex items-center gap-2">
                    <span className={`w-3 h-3 rounded-full animate-pulse ${state?.isRunning ? 'bg-green-500' : 'bg-red-500'}`}></span>
                    وضعیت فعلی ربات تلگرام
                  </h3>
                  <p className="text-sm text-gray-500 mt-1">
                    {state?.isRunning 
                      ? 'ربات متصل است و در گروه‌ها پیام‌ها را به دنبال کدهای تعریف شده اسکن می‌کند.' 
                      : 'ربات غیرفعال است و اسکن کد کالاها متوقف شده است.'}
                  </p>
                </div>
                <div>
                  <div className="flex gap-3 items-center">
                    <button 
                      onClick={toggleBot}
                      className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold text-white shadow-sm transition-all
                        ${state?.isRunning ? 'bg-red-500 hover:bg-red-600' : 'bg-green-600 hover:bg-green-700'}
                      `}
                    >
                      {state?.isRunning ? <Square size={16} className="fill-current" /> : <Play size={16} className="fill-current" />}
                      {state?.isRunning ? 'خاموش کردن / غیرفعال‌سازی ربات' : 'روشن کردن / فعال‌سازی ربات'}
                    </button>
                  </div>
                </div>
              </div>

              <h2 className="text-lg font-bold mb-6 text-gray-800">تنظیمات و پیکربندی ربات</h2>
              
              <div className="space-y-6 max-w-2xl">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">توکن ربات (Bot Token)</label>
                    <input 
                      type="password"
                      value={config.token}
                      onChange={e => setConfig({...config, token: e.target.value})}
                      placeholder="1234567890:AAH..."
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-left dir-ltr"
                    />
                    <p className="mt-2 text-xs text-gray-500">این توکن را از BotFather@ در تلگرام دریافت کنید.</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">آیدی عددی مدیر (Admin Chat ID)</label>
                    <input 
                      type="text"
                      value={config.adminId}
                      onChange={e => setConfig({...config, adminId: e.target.value})}
                      placeholder="12345678"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-left font-mono"
                    />
                    <p className="mt-2 text-xs text-gray-500">برای پیدا کردن آیدی خود، از ربات userinfobot@ استفاده کنید. درخواست سفارشات به این آیدی ارسال می‌شود.</p>
                  </div>
                </div>

                <div className="border-t border-gray-100 pt-6">
                  <label className="block text-sm font-medium text-gray-700 mb-2">آیدی گروه هدف جهت اسکن (Telegram Group ID / Username) <span className="text-gray-400 text-xs font-normal">(اختیاری)</span></label>
                  <input 
                    type="text"
                    value={config.groupId || ''}
                    onChange={e => setConfig({...config, groupId: e.target.value})}
                    placeholder="مثال: -100123456789 یا my_group_username"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-left font-mono"
                  />
                  <p className="mt-2 text-xs text-gray-500">اگر می‌خواهید اسکن کد فقط به یک گروه خاص محدود شود، آیدی عددی (شروع با ۱۰۰-) یا یوزرنیم گروه را بنویسید. در صورت خالی بودن، ربات مستقیماً تمام گروه‌هایی را که در آن‌ها عضو است اسکن می‌کند.</p>
                  
                  {/* Step-by-Step Helper Guide removed */}

                  {/* Discovered Groups Helper list */}
                  {state.groups && state.groups.length > 0 && (
                    <div className="mt-4 bg-blue-50 border border-blue-200 rounded-xl p-4">
                      <span className="font-bold text-blue-800 text-sm block mb-3 flex items-center gap-1.5">
                        <Users size={16} />
                        گروه‌های شناسایی‌شده خودکار (کافیست کلیک کنید):
                      </span>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {state.groups.map(g => (
                          <div key={g.id} className="flex items-center justify-between bg-white px-3 py-2.5 rounded-lg border border-blue-100 shadow-xs">
                            <div className="overflow-hidden">
                              <span className="font-bold text-gray-800 text-sm block truncate">{g.title}</span>
                              <span className="text-xs text-mono text-gray-500 font-mono truncate block mt-0.5" dir="ltr">{g.id}</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setConfig(prev => ({ ...prev, groupId: g.id }));
                                showMessage(`گروه «${g.title}» انتخاب شد. لطفاً دکمه ذخیره تنظیمات را بزنید.`, 'success');
                              }}
                              className="text-xs bg-blue-600 hover:bg-blue-700 text-white font-bold py-1 px-2.5 rounded transition-all cursor-pointer select-none"
                            >
                              انتخاب
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="border-t border-gray-100 pt-6">
                  <label className="block text-sm font-medium text-gray-700 mb-2">محدودیت و امنیت دسترسی در گروه‌ها</label>
                  <select 
                    value={config.groupAccess || 'all'}
                    onChange={e => setConfig({...config, groupAccess: e.target.value as any})}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white transition-all text-sm"
                  >
                    <option value="all">🌐 همه اعضا (هر کسی در گروه پیام حاوی کد معتبر بفرستد، اسکن و ثبت شود)</option>
                    <option value="group_admins">👮 فقط ادمین‌های گروه (فقط مدیران و ادمین‌های گروه بتوانند کالاها را در گروه اسکن کنند)</option>
                    <option value="admin">🔒 فقط مدیر ربات (فقط شما به عنوان مدیر کل ربات بتوانید با ارسال کد در داخل گروه اسکن را تریگر کنید)</option>
                  </select>
                  <p className="mt-2 text-xs text-gray-500">برای برطرف کردن نگرانی دسترسی بقیه افراد گروه به ربات، می‌توانید دسترسی را محدود به ادمین‌های گروه یا فقط حساب خودتان (مدیر کل) نمایید.</p>
                </div>

                <div className="border-t border-gray-100 pt-6 grid grid-cols-1 md:grid-cols-2 gap-6 bg-gray-50 p-4 rounded-xl">
                  <div className="flex items-start gap-3">
                    <input 
                      type="checkbox"
                      id="botEnabled"
                      checked={config.botEnabled !== false}
                      onChange={e => setConfig({...config, botEnabled: e.target.checked})}
                      className="mt-1 h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer"
                    />
                    <div>
                      <label htmlFor="botEnabled" className="block text-sm font-bold text-gray-800 cursor-pointer">
                        🟢 پایش و اسکن هوشمند فعال باشد
                      </label>
                      <p className="mt-1 text-xs text-gray-500">
                        در صورت غیرفعال بودن این گزینه، ربات اسکن کدهای خرید را موقتاً متوقف می‌کند.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <input 
                      type="checkbox"
                      id="disableCustomerPm"
                      checked={!!config.disableCustomerPm}
                      onChange={e => setConfig({...config, disableCustomerPm: e.target.checked})}
                      className="mt-1 h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer"
                    />
                    <div>
                      <label htmlFor="disableCustomerPm" className="block text-sm font-bold text-gray-800 cursor-pointer">
                        📴 غیرفعال کردن پیام به خریدار
                      </label>
                      <p className="mt-1 text-xs text-gray-500">
                        با فعال کردن این گزینه، پس از سفارش هیچ پیامی به مشتری فرستاده نمی‌شود و سفارش خریدار مستقیماً و مخفیانه فقط در پی‌وی شما (ادمین) ثبت می‌گردد.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="border-t border-gray-100 pt-6">
                  <label className="block text-sm font-medium text-gray-700 mb-2">متن اطلاعات ارسالی در پی‌وی مشتری (Customer PV Message Template)</label>
                  <textarea 
                    value={config.customerMessage || ''}
                    onChange={e => setConfig({...config, customerMessage: e.target.value})}
                    placeholder="نمونه: سلام! درخواست شما برای خرید {name} با کد {code} ثبت شد. به زودی در خدمتتان هستیم."
                    rows={4}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-right text-sm leading-relaxed"
                  />
                  <p className="mt-2 text-xs text-gray-500">شما می‌توانید از متغیرهای <code className="bg-gray-100 px-1 py-0.5 rounded font-mono text-blue-600">{`{code}`}</code> برای کد کالا و <code className="bg-gray-100 px-1 py-0.5 rounded font-mono text-blue-600">{`{name}`}</code> برای نام کالا استفاده کنید تا اطلاعات به صورت خودکار جایگذاری شوند.</p>
                </div>

                {/* 🤖 Userbot (Self-Bot) Secure Settings Section */}
                <div className="border-t border-gray-200 pt-8 mt-8">
                  <h4 className="text-md font-bold text-gray-900 mb-2 flex items-center gap-2">
                    <span className="p-1 px-2 rounded-md bg-purple-100 text-purple-700 text-xs">سلف / کاربر</span>
                    🤖 تنظیمات ربات کاربری مبارز با محدودیت ربات‌ها (Telegram Userbot / Self Bot)
                  </h4>
                  <p className="text-xs text-gray-500 mb-6 leading-relaxed">
                    با اتصال اکانت شخصی خود از طریق API رسمی تلگرام، پیام‌های گروه‌های کاری را اسکن کنید. این روش برخلاف ربات‌های معمولی، محدودیت‌های اضافه کردن ربات به گروه‌های قفل‌شده را دور می‌زند و امنیت فوق‌العاده بالایی دارد.
                  </p>

                  <div className="bg-purple-50/50 border border-purple-100 rounded-xl p-6 space-y-6">
                    {/* Active Session Status */}
                    {config.userbotSession ? (
                      <div className="space-y-4">
                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-white p-4 rounded-lg border border-purple-200">
                          <div>
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-50 text-green-700 border border-green-200">
                              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                              فعال و متصل به تلگرام
                            </span>
                            <p className="text-xs text-gray-500 mt-2">
                              ربات کاربری فعال شده است و با موفقیت در پس‌زمینه سرور اطلاعات گروه‌ها را بررسی می‌کند.
                            </p>
                            <div className="mt-2 text-xs font-mono text-purple-600 bg-purple-50 px-2 py-1 rounded inline-block">
                              API ID: {config.userbotApiId}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={handleUserbotLogout}
                            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-bold transition-all shadow-sm"
                          >
                            خروج و قطع اتصال اکانت
                          </button>
                        </div>

                        {/* Interactive Group Selector */}
                        <div className="bg-white p-5 rounded-lg border border-purple-200 space-y-4 text-right">
                          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                            <div>
                              <h5 className="text-sm font-bold text-purple-900 flex items-center gap-1.5">
                                <span className="w-1.5 h-3 bg-purple-600 rounded"></span>
                                📋 لیست گروه‌ها و کانال‌های تلگرام شما
                              </h5>
                              <p className="text-3xs text-gray-500 mt-1">
                                گروه‌هایی را که تمایل دارید پیام‌هایشان برای کدهای خرید پایش شود انتخاب کنید:
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={fetchDialogGroups}
                              disabled={isLoadingDialogs}
                              className="text-xs bg-purple-600 hover:bg-purple-700 text-white px-3.5 py-1.5 rounded-lg font-bold transition-all disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer text-center shadow-sm"
                            >
                              {isLoadingDialogs ? 'درحال بارگذاری...' : '🔄 بارگذاری و بروزرسانی گروه‌ها'}
                            </button>
                          </div>

                          {/* Spinner or Content */}
                          {isLoadingDialogs ? (
                            <div className="flex flex-col items-center justify-center py-8 text-xs text-gray-500 space-y-3">
                              <span className="w-8 h-8 rounded-full border-2 border-purple-200 border-t-purple-600 animate-spin"></span>
                              <p>در حال دریافت لیست مخاطبان، گروه‌ها و سوپرگروه‌ها از تلگرام اکانت شما...</p>
                            </div>
                          ) : dialogGroups.length === 0 ? (
                            <div className="border border-dashed border-purple-200 rounded-lg py-8 px-4 text-center bg-purple-50/10">
                              <p className="text-xs text-gray-500">لیست گروه‌ها هنوز دریافت نشده است یا در حال حاضر خالی است.</p>
                              <button
                                type="button"
                                onClick={fetchDialogGroups}
                                className="text-xs bg-purple-600 hover:bg-purple-700 text-white font-bold py-1.5 px-4 rounded-lg transition-all mx-auto block mt-2 shadow-sm"
                              >
                                دریافت و بروزرسانی لیست گروه‌ها
                              </button>
                            </div>
                          ) : (
                            <div className="space-y-3 font-sans">
                              {/* Search tool */}
                              <input
                                type="text"
                                value={dialogSearch}
                                onChange={e => setDialogSearch(e.target.value)}
                                placeholder="🎯 جستجو در نام گروه یا یوزرنیم..."
                                className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500 text-xs text-right"
                              />

                              {/* Selected List badges */}
                              <div className="flex flex-wrap gap-1.5 p-2 bg-purple-50/50 rounded-lg border border-purple-100/50 text-xs">
                                <span className="text-[11px] text-purple-900 font-bold self-center">گروه‌های انتخاب‌شده برای اسکن:</span>
                                {(() => {
                                  const currentSelected = config.userbotGroups
                                    ? config.userbotGroups.split(',').map(x => x.trim()).filter(Boolean)
                                    : [];
                                  if (currentSelected.length === 0) {
                                    return <span className="text-3xs text-amber-600 self-center">هیچ گروهی انتخاب نشده است (همه گروه‌ها اسکن خواهند شد - پایش عمومی)</span>;
                                  }
                                  return (
                                    <div className="flex flex-wrap gap-1">
                                      {currentSelected.map(id => {
                                        const grp = dialogGroups.find(g => g.id === id);
                                        const displayName = grp ? grp.title : (id.startsWith('@') ? id : `آیدی: ${id}`);
                                        return (
                                          <span key={id} className="inline-flex items-center gap-1 bg-purple-100 text-purple-800 text-[10px] font-bold px-2 py-0.5 rounded-full select-none">
                                            {displayName}
                                            <button
                                              type="button"
                                              onClick={() => handleToggleGroup(id)}
                                              className="text-purple-600 hover:text-purple-900 font-bold text-xs mr-0.5"
                                            >
                                              ×
                                            </button>
                                          </span>
                                        );
                                      })}
                                    </div>
                                  );
                                })()}
                              </div>

                              {/* Scrollable list & Selection */}
                              <div className="max-h-60 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100 text-xs">
                                {(() => {
                                  const filtered = dialogGroups.filter(grp => {
                                    const name = grp.title.toLowerCase();
                                    const user = (grp.username || '').toLowerCase();
                                    const term = dialogSearch.toLowerCase();
                                    return name.includes(term) || user.includes(term);
                                  });

                                  if (filtered.length === 0) {
                                    return <p className="p-4 text-center text-gray-400">گروهی با این مشخصات یافت نشد.</p>;
                                  }

                                  return filtered.map(grp => {
                                    const currentSelected = config.userbotGroups
                                      ? config.userbotGroups.split(',').map(x => x.trim()).filter(Boolean)
                                      : [];
                                    const isChecked = currentSelected.includes(grp.id);

                                    return (
                                      <label
                                        key={grp.id}
                                        className={`flex items-center justify-between p-3 hover:bg-purple-50/20 cursor-pointer transition-all ${isChecked ? 'bg-purple-50/40' : ''}`}
                                      >
                                        <div className="flex items-center gap-2.5">
                                          <input
                                            type="checkbox"
                                            checked={isChecked}
                                            onChange={() => handleToggleGroup(grp.id)}
                                            className="h-4 w-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500 cursor-pointer"
                                          />
                                          <div>
                                            <span className="font-bold text-gray-800 block text-right">{grp.title}</span>
                                            {grp.username && (
                                              <span className="text-3xs text-gray-400 block font-mono text-right" dir="ltr">
                                                @{grp.username}
                                              </span>
                                            )}
                                          </div>
                                        </div>
                                        <div className="flex items-center gap-1.5 text-3xs">
                                          {grp.isChannel ? (
                                            <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded-md font-bold">کانال</span>
                                          ) : (
                                            <span className="px-1.5 py-0.5 bg-purple-50 text-purple-600 rounded-md font-bold">گروه</span>
                                          )}
                                          <span className="text-gray-400 font-mono text-[10px]">{grp.id}</span>
                                        </div>
                                      </label>
                                    );
                                  });
                                })()}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {/* Selector for connection mode */}
                        <div className="flex flex-col sm:flex-row gap-2 p-1 bg-purple-100/50 rounded-lg max-w-lg">
                          <button
                            type="button"
                            onClick={() => setUserbotUseBypass(true)}
                            className={`flex-1 text-center py-2 px-3 rounded-md text-xs font-bold transition-all cursor-pointer ${userbotUseBypass ? 'bg-purple-600 text-white shadow-sm' : 'text-purple-700 hover:bg-purple-100'}`}
                          >
                            🚀 اتصال سریع و بدون خطا (پیشنهادی - بدون نیاز به ساخت فایل)
                          </button>
                          <button
                            type="button"
                            onClick={() => setUserbotUseBypass(false)}
                            className={`flex-1 text-center py-2 px-3 rounded-md text-xs font-bold transition-all cursor-pointer ${!userbotUseBypass ? 'bg-purple-600 text-white shadow-sm' : 'text-purple-700 hover:bg-purple-100'}`}
                          >
                            ⚙️ وارد کردن دستی api_id و api_hash
                          </button>
                        </div>

                        {userbotUseBypass ? (
                          <div className="bg-green-50 border border-green-200 rounded-lg p-3.5 text-xs text-green-800 leading-relaxed space-y-1">
                            <p className="font-bold">✅ حالت اتصال سریع و هوشمند فعال است!</p>
                            <p>در این روش، تلگرام از کدهای شناسایی رسمی و ایمن دسکتاپ استفاده می‌کند. نیازی به ورود به سایت <span className="font-mono">my.telegram.org</span> ندارید و با هیچ اروری در ساخت برنامه مواجه نخواهید شد.</p>
                            <p className="text-gray-500 text-[11px] mt-1">توضیح: کافیست شماره خود را وارد کنید، کد تایید دریافتی از تلگرام را بنویسید و کار تمام است!</p>
                          </div>
                        ) : (
                          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 leading-relaxed">
                            ⚠️ <strong>روش دستی:</strong> برای فعال‌سازی با روش سنتی به <strong>api_id</strong> و <strong>api_hash</strong> نیاز دارید که باید به صورت رایگان از سایت رسمی <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer" className="underline font-bold">my.telegram.org</a> دریافت گردد.
                          </div>
                        )}

                        {userbotStep === 'request_code' ? (
                          <div className={`grid grid-cols-1 ${userbotUseBypass ? 'max-w-md' : 'md:grid-cols-3'} gap-4`}>
                            {!userbotUseBypass && (
                              <>
                                <div>
                                  <label className="block text-xs font-bold text-gray-700 mb-1.5">آیدی API (api_id)</label>
                                  <input
                                    type="text"
                                    value={userbotApiIdInput}
                                    onChange={e => setUserbotApiIdInput(e.target.value)}
                                    placeholder="مثال: 123456"
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 text-left font-mono text-sm"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-bold text-gray-700 mb-1.5">هش API (api_hash)</label>
                                  <input
                                    type="text"
                                    value={userbotApiHashInput}
                                    onChange={e => setUserbotApiHashInput(e.target.value)}
                                    placeholder="مثال: e34f9a3f..."
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 text-left font-mono text-sm"
                                  />
                                </div>
                              </>
                            )}
                            <div>
                              <label className="block text-xs font-bold text-gray-700 mb-1.5">شماره تلفن اکانت تلگرام</label>
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  value={userbotPhone}
                                  onChange={e => setUserbotPhone(e.target.value)}
                                  placeholder="989123456789+"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 text-left font-mono text-sm"
                                  dir="ltr"
                                />
                                <button
                                  type="button"
                                  disabled={userbotIsConnecting}
                                  onClick={handleUserbotSendCode}
                                  className="bg-purple-600 hover:bg-purple-700 disabled:bg-purple-300 text-white px-4 py-2 rounded-lg text-xs font-bold transition-all shrink-0"
                                >
                                  {userbotIsConnecting ? 'درحال ارسال...' : 'ارسال کد'}
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="bg-white p-4 rounded-lg border border-purple-200 space-y-4">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-bold text-purple-700 block">📥 تایید هویت دو مرحله‌ای تلگرام</span>
                              {userbotSentCodeType === 'auth.SentCodeTypeEmailCode' && (
                                <span className="bg-amber-100 text-amber-800 text-[10px] px-2.5 py-0.5 rounded-full font-bold">
                                  ارسال شده به ایمیل
                                </span>
                              )}
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                              <div>
                                <label className="block text-xs font-bold text-gray-700 mb-1.5">
                                  {userbotSentCodeType === 'auth.SentCodeTypeEmailCode' ? 'کد تایید دریافتی از ایمیل' : 'کد تایید دریافتی تلگرام'}
                                </label>
                                <input
                                  type="text"
                                  value={userbotCodeInput}
                                  onChange={e => setUserbotCodeInput(e.target.value)}
                                  placeholder={userbotSentCodeType === 'auth.SentCodeTypeEmailCode' ? 'کد ارسالی به ایمیل شما' : 'کد پیامک یا پیام تلگرام'}
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 text-center font-mono text-sm"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-bold text-gray-700 mb-1.5">رمز عبور دو مرحله‌ای (گذرواژه ابری) <span className="text-gray-400 font-normal">(در صورت فعال بودن)</span></label>
                                <input
                                  type="password"
                                  value={userbot2FaInput}
                                  onChange={e => setUserbot2FaInput(e.target.value)}
                                  placeholder="گذرواژه تایید دو مرحله‌ای"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 text-center font-mono text-sm"
                                />
                              </div>
                              <div className="flex items-end gap-2">
                                <button
                                  type="button"
                                  disabled={userbotIsConnecting}
                                  onClick={handleUserbotVerifyCode}
                                  className="w-full bg-green-600 hover:bg-green-700 disabled:bg-green-300 text-white py-2.5 rounded-lg text-xs font-bold transition-all"
                                >
                                  {userbotIsConnecting ? 'درحال اتصال...' : 'تایید هویت و فعالسازی'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setUserbotStep('request_code');
                                    setUserbotStatusMsg('');
                                    setUserbotCodeInput('');
                                    setUserbot2FaInput('');
                                    setUserbotSentCodeType(null);
                                    setUserbotEmailPattern(null);
                                    setUserbotCodeLength(null);
                                  }}
                                  className="px-3 py-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition-all shrink-0 shadow-sm cursor-pointer"
                                >
                                  بازگشت
                                </button>
                              </div>
                            </div>
                          </div>
                        )}

                        {userbotStatusMsg && (
                          <p className="text-xs font-bold text-purple-700 bg-purple-50 p-2.5 rounded-lg border border-purple-100">
                            ℹ️ {userbotStatusMsg}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Configuration settings applied online */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-purple-100 pt-4">
                      <div>
                        <div className="flex items-start gap-2.5">
                          <input
                            type="checkbox"
                            id="userbotEnabled"
                            checked={config.userbotEnabled || false}
                            onChange={e => setConfig({ ...config, userbotEnabled: e.target.checked })}
                            className="mt-1 h-4 w-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500 cursor-pointer"
                          />
                          <div>
                            <label htmlFor="userbotEnabled" className="block text-xs font-bold text-purple-900 cursor-pointer">
                              پایش و اسکن ربات کاربر (سلف) روشن باشد
                            </label>
                            <p className="text-3xs text-gray-500 mt-1">
                              با خاموش کردن این گزینه، فعالیت ربات کاربر (سلف) در پس‌زمینه متوقف می‌شود.
                            </p>
                          </div>
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-purple-900 mb-1">
                          گروه‌های تحت اسکن سلف (Watchlist) <span className="text-gray-400 text-3xs font-normal">(پیشنهادی: فقط ۱ الی ۲ گروه)</span>
                        </label>
                        <input
                          type="text"
                          value={config.userbotGroups || ''}
                          onChange={e => setConfig({ ...config, userbotGroups: e.target.value })}
                          placeholder="مثال: -100122332, @my_watch_group"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 font-mono text-xs text-left"
                        />
                        <p className="text-3xs text-gray-500 mt-1 leading-relaxed">
                          آیدی عددی (شروع با ۱۰۰-) یا آیدی یوزرنیم گروه‌ها را با ویرگول فرنگی (<code className="bg-gray-100 px-1 py-0.5 rounded font-mono text-purple-600">,</code>) جدا کنید. حتماً فقط گروه‌های مورد نظر را بنویسید تا ریسک استفاده از سلف کاهش یابد.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t border-gray-100 flex items-center justify-between">
                  <button 
                    onClick={handleSaveConfig}
                    className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg font-bold transition-all shadow-sm cursor-pointer"
                  >
                    <Save size={18} />
                    ذخیره تنظیمات
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'inventory' && (
            <div className="p-6 space-y-8">
              {/* Main title */}
              <div className="border-b border-gray-100 pb-4">
                <h2 className="text-xl font-bold text-gray-800">مدیریت لیست محصولات انبار</h2>
                <p className="text-sm text-gray-500 mt-1">با استفاده از ابزارهای زیر، کالاها و لیست انبار ربات را بارگذاری، بروزرسانی و مدیریت کنید.</p>
              </div>

              {/* Three Separate Administrative Panels */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                
                {/* Panel A: Download Template Excel */}
                <div className="p-6 bg-teal-50/50 border border-teal-200 rounded-xl shadow-sm flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-teal-800 font-bold mb-2">
                      <FileDown size={20} />
                      <h4>۱. دانلود فایل پیش‌فرض نمونه اکسل</h4>
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed mb-4">
                      جهت تعریف کالاها به صورت دسته‌جمعی، ابتدا این قالب اکسل نمونه را دانلود نمایید و اطلاعات کالاها را در ستون‌های تنظیم‌شده وارد کنید.
                    </p>
                  </div>
                  <button 
                    onClick={downloadSampleExcel}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg font-bold bg-teal-600 hover:bg-teal-700 text-white shadow-sm text-sm transition-all"
                  >
                    <FileDown size={18} />
                    دانلود فایل نمونه اکسل (xlsx)
                  </button>
                </div>

                {/* Panel B: Upload Excel File */}
                <div className="p-6 bg-blue-50/50 border border-blue-200 rounded-xl shadow-sm flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-blue-800 font-bold mb-2">
                      <Upload size={20} />
                      <h4>۲. آپلود لیست کالاها از فایل اکسل</h4>
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed mb-4">
                      یک فایل اکسل پر شده آپلود کنید. لیست تمام موجودی‌های قبلی ربات با محصولات فایل جدید جایگزین شده و بلافاصله آماده اسکن می‌شود.
                    </p>
                  </div>
                  <div className="relative">
                    <input 
                      type="file" 
                      accept=".xlsx, .xls"
                      onChange={handleFileUpload}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      disabled={isUploading}
                    />
                    <button className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg font-bold text-sm transition-all shadow-sm ${isUploading ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                      <Upload size={18} />
                      {isUploading ? 'در حال پردازش فایل...' : 'آپلود فایل اکسل محصولات'}
                    </button>
                  </div>
                </div>

              </div>

              {/* Panel C: Manual Product Registration Form (Separate section) */}
              <div className="p-6 bg-white border border-gray-200 rounded-xl shadow-sm">
                <div className="flex items-center gap-2 text-blue-600 font-bold mb-4 border-b border-gray-100 pb-3">
                  {isEditing ? <Edit size={20} className="text-amber-500" /> : <Plus size={20} />}
                  <h4>۳. {isEditing ? 'ویرایش اطلاعات کالا' : 'افزودن و ثبت دستی کالا'}</h4>
                </div>
                
                <form onSubmit={handleAddOrUpdateManual} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1.5">کد کالا <span className="text-red-500">*</span></label>
                    <input 
                      type="text" 
                      placeholder="مثال: SH-101"
                      value={manualCode}
                      onChange={e => setManualCode(e.target.value)}
                      disabled={isEditing}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm font-mono placeholder:font-sans"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1.5">نام کالا (اختیاری)</label>
                    <input 
                      type="text" 
                      placeholder="مثال: تیشرت مشکی" 
                      value={manualName}
                      onChange={e => setManualName(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1.5">موجودی کالا (عدد - خالی یعنی ۱ کالا)</label>
                    <input 
                      type="number" 
                      placeholder="مثال: 15" 
                      value={manualStock}
                      onChange={e => setManualStock(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button 
                      type="submit" 
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-4 rounded-lg font-bold text-sm text-white transition-all shadow-sm ${isEditing ? 'bg-amber-500 hover:bg-amber-600' : 'bg-green-600 hover:bg-green-700'}`}
                    >
                      <Save size={16} />
                      {isEditing ? 'بروزرسانی کالا' : 'ثبت کالا'}
                    </button>
                    {isEditing && (
                      <button 
                        type="button" 
                        onClick={() => {
                          setManualCode('');
                          setManualName('');
                          setManualStock('');
                          setIsEditing(false);
                        }}
                        className="py-2 px-4 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg text-sm transition-all shadow-sm cursor-pointer"
                      >
                        انصراف
                      </button>
                    )}
                  </div>
                </form>
              </div>

              {/* Inventory Table List */}
              <div className="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
                <div className="p-4 bg-gray-50 border-b border-gray-200">
                  <h4 className="font-bold text-sm text-gray-800">لیست کل کالاهای تعریف شده</h4>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-right">
                    <thead className="bg-gray-50 text-gray-600 text-xs border-b border-gray-200">
                      <tr>
                        <th className="px-6 py-3 font-medium">کد کالا</th>
                        <th className="px-6 py-3 font-medium">نام کالا</th>
                        <th className="px-6 py-3 font-medium">موجودی</th>
                        <th className="px-6 py-3 font-medium">وضعیت</th>
                        <th className="px-6 py-3 font-medium text-center">عملیات</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 text-sm">
                    {state?.inventory && state.inventory.length > 0 ? (
                      state.inventory.map((item, idx) => (
                        <tr key={idx} className="hover:bg-gray-50 transition-colors">
                          <td className="px-6 py-4 font-mono text-gray-600">{item.code}</td>
                          <td className="px-6 py-4 font-medium">{item.name}</td>
                          <td className="px-6 py-4">{item.stock}</td>
                          <td className="px-6 py-4">
                            {item.stock > 0 
                              ? <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-green-50 text-green-700 border border-green-200">موجود</span>
                              : <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-red-50 text-red-700 border border-red-200">ناموجود</span>
                            }
                          </td>
                          <td className="px-6 py-4 text-center">
                            <div className="inline-flex gap-2">
                              <button 
                                onClick={() => handleSelectForEdit(item)}
                                className="p-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors shadow-xs cursor-pointer"
                                title="ویرایش کالا"
                              >
                                <Edit size={16} />
                              </button>
                              <button 
                                onClick={() => handleDeleteItem(item.code)}
                                className="p-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors shadow-xs cursor-pointer"
                                title="حذف کالا"
                              >
                                <Trash size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={5} className="px-6 py-12 text-center text-gray-500">
                          هیچ کالایی در سیستم ثبت نشده است. کالاها را به صورت دستی ثبت کنید یا فایل اکسل خود را آپلود کنید.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

          {activeTab === 'customers' && (
            <div className="p-0">
              <div className="p-6 border-b border-gray-200 bg-gray-50">
                <h2 className="text-lg font-bold">لیست درخواست‌های مشتریان</h2>
                <p className="text-sm text-gray-500 mt-1">اطلاعات کسانی که در گروه‌ها کد کالاهای موجود را ارسال کرده‌اند.</p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-right">
                  <thead className="bg-gray-50 text-gray-600 text-sm border-b border-gray-200">
                    <tr>
                      <th className="px-6 py-3 font-medium">زمان درخواست</th>
                      <th className="px-6 py-3 font-medium">کاربر</th>
                      <th className="px-6 py-3 font-medium">گروه</th>
                      <th className="px-6 py-3 font-medium">کالا</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 text-sm">
                    {state?.customers && state.customers.length > 0 ? (
                      [...state.customers].reverse().map((req, idx) => (
                        <tr key={idx} className="hover:bg-gray-50 transition-colors">
                          <td className="px-6 py-4 whitespace-nowrap text-gray-500" dir="ltr">{new Date(req.date).toLocaleString('fa-IR')}</td>
                          <td className="px-6 py-4">
                            <div className="font-medium">@{req.username}</div>
                            <div className="text-xs text-gray-500 font-mono mt-1">{req.userId}</div>
                          </td>
                          <td className="px-6 py-4">{req.chatTitle}</td>
                          <td className="px-6 py-4">
                            <div className="font-medium">{req.itemName}</div>
                            <div className="text-xs text-gray-500 font-mono mt-1">کد: {req.itemCode}</div>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={4} className="px-6 py-12 text-center text-gray-500">
                          تا کنون هیچ درخواستی ثبت نشده است.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

