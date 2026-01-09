
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { extractTextFromPdf, getPageCount, splitPdf, ProgressCallback } from './services/pdfService';
import { extractLegalData, extractLegalDataFromModality } from './services/geminiService';
import { LegalProcess, GroupedProcesses, WorkspaceFile, HistoryItem } from './types';
import { jsPDF } from 'jspdf';

const App: React.FC = () => {
  const [view, setView] = useState<'home' | 'tool' | 'detail'>('home');
  const [sidebarTab, setSidebarTab] = useState<'workspace' | 'history'>('workspace');
  const [toolMode, setToolMode] = useState<'extract' | 'split' | 'consolidated' | 'ocr'>('extract');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{current: number, total: number, phase: 'extracting' | 'analyzing' | 'idle'}>({current: 0, total: 0, phase: 'idle'});
  const [error, setError] = useState<string | null>(null);
  
  // Data States
  const [groupedData, setGroupedData] = useState<GroupedProcesses | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [expandedResults, setExpandedResults] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  
  // Detail View Tabs and Selection
  const [detailTab, setDetailTab] = useState<'summary' | 'details'>('summary');
  const [selectedForos, setSelectedForos] = useState<Set<string>>(new Set());

  // Consolidated View Selection and Sorting
  const [consolidatedSelection, setConsolidatedSelection] = useState<Set<string>>(new Set());
  const [foroSortOrder, setForoSortOrder] = useState<'asc' | 'desc'>('asc');

  // Sequential Processing State
  const [isSequentialRunning, setIsSequentialRunning] = useState(false);
  const isBatchStopped = useRef(false);

  // Simulated Analyzing Progress
  const [simulatedProgress, setSimulatedProgress] = useState(0);
  const simulatedInterval = useRef<number | null>(null);

  // Workspace States
  const [workspace, setWorkspace] = useState<WorkspaceFile[]>([]);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [pagesPerPart, setPagesPerPart] = useState<number>(10);
  const [currentFile, setCurrentFile] = useState<File | null>(null);

  // Cancellation Tracking
  const activeProcesses = useRef<Record<string, boolean>>({});

  useEffect(() => {
    const savedHistory = localStorage.getItem('legal_filter_history');
    if (savedHistory) {
      try {
        setHistory(JSON.parse(savedHistory));
      } catch (e) {
        console.error("Erro ao carregar histórico");
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('legal_filter_history', JSON.stringify(history));
  }, [history]);

  // Derived Data for Consolidated View
  const globalForos = useMemo(() => {
    const map: Record<string, { procesos: Set<string>, docs: Set<string> }> = {};
    history.forEach(item => {
      Object.entries(item.results).forEach(([foro, processos]) => {
        if (!map[foro]) map[foro] = { procesos: new Set(), docs: new Set() };
        processos.forEach(p => map[foro].procesos.add(p));
        map[foro].docs.add(item.name);
      });
    });
    return map;
  }, [history]);

  // Sorted Global Foros for UI
  const sortedGlobalForos = useMemo(() => {
    const entries = Object.entries(globalForos);
    return entries.sort((a, b) => {
      if (foroSortOrder === 'asc') {
        return a[0].localeCompare(b[0], 'pt-BR');
      } else {
        return b[0].localeCompare(a[0], 'pt-BR');
      }
    });
  }, [globalForos, foroSortOrder]);

  // Handle simulated progress for Analyzing phase
  useEffect(() => {
    if (progress.phase === 'analyzing') {
      setSimulatedProgress(0);
      simulatedInterval.current = window.setInterval(() => {
        setSimulatedProgress(prev => {
          if (prev >= 92) return prev;
          return prev + Math.floor(Math.random() * 5) + 1;
        });
      }, 600);
    } else {
      if (simulatedInterval.current) clearInterval(simulatedInterval.current);
      setSimulatedProgress(0);
    }
    return () => {
      if (simulatedInterval.current) clearInterval(simulatedInterval.current);
    };
  }, [progress.phase]);

  const toggleExpand = (id: string) => {
    setExpandedResults(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const stopAnalysis = (id: string) => {
    isBatchStopped.current = true;
    Object.keys(activeProcesses.current).forEach(key => {
      activeProcesses.current[key] = false;
    });
    setWorkspace(prev => prev.map(f => ({ ...f, status: f.status === 'processing' ? 'idle' : f.status })));
    setLoading(false);
    setIsSequentialRunning(false);
    setProgress({current: 0, total: 0, phase: 'idle'});
    setError(null);
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64String = reader.result as string;
        resolve(base64String.split(',')[1]);
      };
      reader.onerror = error => reject(error);
    });
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const isPdf = file.type === 'application/pdf';
    const isImage = file.type.startsWith('image/');

    if (toolMode === 'ocr') {
      if (!isImage && !isPdf) {
        setError('Por favor, anexe um arquivo de imagem (JPEG/PNG) ou um PDF para o modo OCR.');
        return;
      }
      await processModalityForOcr(file, file.name, 'direct_ocr');
      return;
    }

    if (!isPdf) {
      setError('Por favor, anexe um arquivo PDF válido.');
      return;
    }

    setFileName(file.name);
    setCurrentFile(file);
    setError(null);

    if (toolMode === 'extract') {
      await processFileForExtraction(file, file.name, 'direct_upload');
    } else if (toolMode === 'split') {
      const count = await getPageCount(file);
      setTotalPages(count);
    }
  };

  const processModalityForOcr = async (file: File, name: string, processId: string) => {
    activeProcesses.current[processId] = true;
    setLoading(true);
    setFileName(name);
    setGroupedData(null);
    setError(null);
    setProgress({current: 1, total: 1, phase: 'analyzing'});
    
    try {
      const base64 = await fileToBase64(file);
      if (!activeProcesses.current[processId]) return;

      const extracted = await extractLegalDataFromModality(base64, file.type, searchQuery);
      if (!activeProcesses.current[processId]) return;

      const grouped: GroupedProcesses = {};
      if (extracted.processes && extracted.processes.length > 0) {
        extracted.processes.forEach((p) => {
          if (!grouped[p.foro]) grouped[p.foro] = [];
          grouped[p.foro].push(p.processo);
        });
      }
      
      setGroupedData(grouped);
      
      const newHistoryItem: HistoryItem = {
        id: crypto.randomUUID(),
        name: name + (file.type.startsWith('image/') ? ' (OCR Imagem)' : ' (OCR PDF)'),
        timestamp: Date.now(),
        results: grouped
      };
      setHistory(prev => [newHistoryItem, ...prev]);
      
    } catch (err: any) {
      if (activeProcesses.current[processId]) {
        setError(err.message || 'Erro inesperado ao processar o documento via OCR.');
      }
    } finally {
      if (activeProcesses.current[processId]) {
        setLoading(false);
        setProgress({current: 0, total: 0, phase: 'idle'});
        activeProcesses.current[processId] = false;
      }
    }
  };

  const processFileForExtraction = async (file: File | Blob, name: string, processId: string) => {
    activeProcesses.current[processId] = true;
    setLoading(true);
    setFileName(name);
    setGroupedData(null);
    setError(null);
    setProgress({current: 0, total: 0, phase: 'extracting'});
    
    try {
      const onProgress: ProgressCallback = (current, total) => {
        if (activeProcesses.current[processId]) {
          setProgress({current, total, phase: 'extracting'});
        }
      };

      const rawText = await extractTextFromPdf(file, onProgress);
      if (!activeProcesses.current[processId]) return;
      if (!rawText.trim()) throw new Error('O arquivo parece estar vazio ou não contém texto extraível.');
      
      setProgress({current: 0, total: 0, phase: 'analyzing'});
      const extracted = await extractLegalData(rawText, searchQuery);
      if (!activeProcesses.current[processId]) return;

      const grouped: GroupedProcesses = {};
      if (extracted.processes && extracted.processes.length > 0) {
        extracted.processes.forEach((p) => {
          if (!grouped[p.foro]) grouped[p.foro] = [];
          grouped[p.foro].push(p.processo);
        });
      }
      
      setGroupedData(grouped);
      
      const newHistoryItem: HistoryItem = {
        id: crypto.randomUUID(),
        name: name + (searchQuery ? ' (Filtro)' : ''),
        timestamp: Date.now(),
        results: grouped
      };
      setHistory(prev => [newHistoryItem, ...prev]);
      
    } catch (err: any) {
      if (activeProcesses.current[processId]) {
        setError(err.message || 'Erro inesperado ao processar o arquivo.');
      }
    } finally {
      if (activeProcesses.current[processId]) {
        setLoading(false);
        setProgress({current: 0, total: 0, phase: 'idle'});
        activeProcesses.current[processId] = false;
      }
    }
  };

  const analyzeWorkspaceFile = async (file: WorkspaceFile) => {
    setToolMode('extract');
    const processId = 'direct_upload'; 
    activeProcesses.current[processId] = true;
    activeProcesses.current[file.id] = true;
    
    setFileName(file.name);
    setLoading(true);
    setGroupedData(null);
    setError(null);
    setProgress({current: 0, total: 0, phase: 'extracting'});

    setWorkspace(prev => prev.map(f => f.id === file.id ? { ...f, status: 'processing', selected: false } : f));
    
    try {
      const onProgress: ProgressCallback = (current, total) => {
        if (activeProcesses.current[processId]) {
          setProgress({current, total, phase: 'extracting'});
        }
      };

      const rawText = await extractTextFromPdf(file.blob, onProgress);
      if (!activeProcesses.current[processId]) return;

      if (!rawText.trim()) throw new Error('Não foi possível extrair texto desta parte do documento.');

      setProgress({current: 0, total: 0, phase: 'analyzing'});
      const extracted = await extractLegalData(rawText, searchQuery);
      if (!activeProcesses.current[processId]) return;

      const grouped: GroupedProcesses = {};
      if (extracted.processes && extracted.processes.length > 0) {
        extracted.processes.forEach((p) => {
          if (!grouped[p.foro]) grouped[p.foro] = [];
          grouped[p.foro].push(p.processo);
        });
      }
      
      setWorkspace(prev => prev.map(f => f.id === file.id ? { 
        ...f, 
        status: 'completed', 
        results: grouped,
        selected: false
      } : f));
      
      setGroupedData(grouped);
      
      const newHistoryItem: HistoryItem = {
        id: crypto.randomUUID(),
        name: `${file.name}${searchQuery ? ' (Filtro)' : ''}`,
        timestamp: Date.now(),
        results: grouped
      };
      setHistory(prev => [newHistoryItem, ...prev]);
    } catch (err: any) {
      if (activeProcesses.current[processId]) {
        setWorkspace(prev => prev.map(f => f.id === file.id ? { ...f, status: 'error' } : f));
        setError(err.message || 'Erro ao analisar arquivo do workspace.');
      }
    } finally {
      activeProcesses.current[processId] = false;
      activeProcesses.current[file.id] = false;
      if (!isSequentialRunning) {
        setLoading(false);
      }
    }
  };

  const analyzeBatchSequential = async () => {
    const selectedFiles = workspace.filter(f => f.selected && f.status !== 'completed');
    if (selectedFiles.length === 0 || isSequentialRunning) return;
    
    isBatchStopped.current = false;
    setIsSequentialRunning(true);
    
    for (const file of selectedFiles) {
      if (isBatchStopped.current) break;
      await analyzeWorkspaceFile(file);
    }
    
    setIsSequentialRunning(false);
    setLoading(false);
    setProgress({current: 0, total: 0, phase: 'idle'});
  };

  const toggleFileSelection = (id: string) => {
    setWorkspace(prev => prev.map(f => {
      if (f.id === id) {
        if (f.status === 'completed') return { ...f, selected: false };
        return { ...f, selected: !f.selected };
      }
      return f;
    }));
  };

  const toggleAllSelection = () => {
    const selectableFiles = workspace.filter(f => f.status !== 'completed');
    if (selectableFiles.length === 0) return;

    const allSelectableSelected = selectableFiles.every(f => f.selected);
    
    setWorkspace(prev => prev.map(f => {
      if (f.status === 'completed') return { ...f, selected: false };
      return { ...f, selected: !allSelectableSelected };
    }));
  };

  const calculateRemainingTime = () => {
    if (!loading) return null;
    let totalSeconds = 0;
    if (progress.phase === 'extracting') {
      const remainingPages = progress.total - progress.current;
      totalSeconds = (remainingPages * 0.6) + 15;
    } else if (progress.phase === 'analyzing') {
      totalSeconds = 15 * (1 - (simulatedProgress / 100));
    }

    if (totalSeconds <= 0) return "Finalizando...";
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    if (minutes > 0) return `Tempo estimado: ${minutes}m ${seconds}s`;
    return `Tempo estimado: ${seconds}s`;
  };

  const handleSplit = async () => {
    if (!currentFile || !pagesPerPart) return;
    setLoading(true);
    setError(null);
    try {
      const parts = await splitPdf(currentFile, pagesPerPart);
      const workspaceParts: WorkspaceFile[] = parts.map(part => ({
        id: crypto.randomUUID(),
        name: part.name,
        blob: part.blob,
        pageCount: part.pageCount,
        status: 'idle',
        selected: true
      }));
      setWorkspace(prev => [...prev, ...workspaceParts]);
      setSidebarTab('workspace');
    } catch (err: any) {
      setError(err.message || 'Erro ao dividir PDF.');
    } finally {
      setLoading(false);
    }
  };

  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name.endsWith('.pdf') ? name : `${name}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadResults = (results: GroupedProcesses, name: string, filterForos?: Set<string>) => {
    let text = `ANÁLISE DE PROCESSOS - ${name}\n`;
    text += `Data: ${new Date().toLocaleString()}\n`;
    text += `=====================================\n\n`;
    
    Object.entries(results).forEach(([foro, processos]) => {
      if (filterForos && !filterForos.has(foro)) return;
      text += `FORO: ${foro}\n`;
      processos.forEach(p => text += `  - ${p}\n`);
      text += '\n';
    });
    
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `resultados_${name.replace(/\s+/g, '_')}${filterForos ? '_selecao' : ''}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadResultsAsPdf = (results: GroupedProcesses, name: string, filterForos?: Set<string>) => {
    const doc = new jsPDF();
    let y = 20;
    doc.setFontSize(16);
    doc.text(`Análise de Processos: ${name}`, 10, y);
    y += 10;
    doc.setFontSize(10);
    doc.text(`Gerado em: ${new Date().toLocaleString()}`, 10, y);
    y += 15;

    Object.entries(results).forEach(([foro, processos]) => {
      if (filterForos && !filterForos.has(foro)) return;
      
      if (y > 270) { doc.addPage(); y = 20; }
      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.text(`FORO: ${foro}`, 10, y);
      y += 7;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      processos.forEach(p => {
        if (y > 280) { doc.addPage(); y = 20; }
        doc.text(`- ${p}`, 15, y);
        y += 5;
      });
      y += 5;
    });

    doc.save(`analise_${name.replace(/\s+/g, '_')}${filterForos ? '_selecao' : ''}.pdf`);
  };

  const exportAllHistory = () => {
    if (history.length === 0) return;
    let text = "RELATÓRIO CONSOLIDADO DE BUSCAS\n";
    text += `Gerado em: ${new Date().toLocaleString()}\n`;
    text += "=====================================\n\n";

    history.forEach(item => {
      text += `DOCUMENTO: ${item.name}\n`;
      text += `DATA: ${new Date(item.timestamp).toLocaleString()}\n`;
      text += `-------------------------------------\n`;
      Object.entries(item.results).forEach(([foro, processos]) => {
        text += `FORO: ${foro} (${processos.length} processos)\n`;
        processos.forEach(p => text += `  - ${p}\n`);
      });
      text += "\n\n";
    });

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `historico_consolidado_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadConsolidatedSelection = (format: 'pdf' | 'txt') => {
    if (consolidatedSelection.size === 0) return;
    const merged: GroupedProcesses = {};
    consolidatedSelection.forEach(foro => {
      if (globalForos[foro]) {
        merged[foro] = Array.from(globalForos[foro].procesos);
      }
    });

    if (format === 'txt') {
      downloadResults(merged, "Consolidado_Multi_Documentos", consolidatedSelection);
    } else {
      downloadResultsAsPdf(merged, "Consolidado_Multi_Documentos", consolidatedSelection);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    alert('Copiado para a área de transferência!');
  };

  const formatAllForExport = (data: GroupedProcesses | null) => {
    if (!data) return '';
    let text = '';
    Object.entries(data).forEach(([foro, processos]) => {
      text += `${foro}\n${processos.join('\n')}\n\n`;
    });
    return text;
  };

  const openDetailView = (data: GroupedProcesses, name: string) => {
    setGroupedData(data);
    setFileName(name);
    setSelectedForos(new Set()); 
    setDetailTab('summary');
    setView('detail');
  };

  const toggleForoSelection = (foro: string) => {
    const newSelection = new Set(selectedForos);
    if (newSelection.has(foro)) {
      newSelection.delete(foro);
    } else {
      newSelection.add(foro);
    }
    setSelectedForos(newSelection);
  };

  const toggleConsolidatedSelection = (foro: string) => {
    const newSelection = new Set(consolidatedSelection);
    if (newSelection.has(foro)) {
      newSelection.delete(foro);
    } else {
      newSelection.add(foro);
    }
    setConsolidatedSelection(newSelection);
  };

  const SidebarCard = ({ children, title, subtitle, status, statusColor, actions, selected, onToggleSelect, isCompleted }: any) => (
    <div className={`p-4 rounded-2xl border transition-all group duration-300 ${selected ? 'border-indigo-300 bg-white shadow-lg ring-1 ring-indigo-50' : 'border-slate-100 bg-slate-50'} ${isCompleted ? 'opacity-70 grayscale-[0.5]' : ''}`}>
      <div className="flex justify-between items-start mb-1">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          {onToggleSelect && (
             <input 
              type="checkbox" 
              checked={selected} 
              onChange={onToggleSelect} 
              disabled={isCompleted}
              className={`mt-1 w-4 h-4 text-indigo-600 border-slate-300 rounded focus:ring-indigo-500 transition-all ${isCompleted ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
            />
          )}
          <h4 className={`text-xs font-bold truncate pr-2 uppercase tracking-tight transition-colors ${selected ? 'text-indigo-900' : 'text-slate-800'} ${isCompleted ? 'text-slate-400' : ''}`} title={title}>{title}</h4>
        </div>
        {status && (
          <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-full uppercase ${statusColor || 'bg-slate-200 text-slate-500'}`}>
            {status}
          </span>
        )}
      </div>
      <p className="text-[10px] text-slate-400 font-medium mb-1 ml-6">{subtitle}</p>
      {children}
      <div className="flex gap-2 mt-3 flex-wrap ml-6">
        {actions}
      </div>
    </div>
  );

  const ResultsAccordion = ({ item }: { item: HistoryItem }) => {
    const isExpanded = expandedResults[item.id];
    const data = item.results;
    const totalCount = Object.values(data).reduce((acc, curr) => acc + curr.length, 0);

    return (
      <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden mb-4 transition-all hover:shadow-xl hover:scale-[1.01] duration-300">
        <div 
          className="flex items-center justify-between px-6 py-5 bg-slate-50/50 cursor-pointer hover:bg-slate-50 transition-colors"
          onClick={() => toggleExpand(item.id)}
        >
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <div className={`p-2.5 rounded-xl ${isExpanded ? 'bg-indigo-600 text-white shadow-indigo-100 shadow-lg' : 'bg-slate-200 text-slate-500'} transition-all`}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
            </div>
            <div className="truncate">
              <h4 className="font-bold text-slate-800 truncate text-sm">{item.name}</h4>
              <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest">
                {new Date(item.timestamp).toLocaleDateString('pt-BR')} • {totalCount} Processos
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 ml-4">
            <button 
              onClick={(e) => { e.stopPropagation(); downloadResults(data, item.name); }}
              className="p-2 text-slate-400 hover:text-indigo-600 transition-colors"
              title="Baixar em TXT"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
            </button>
            <button 
              onClick={(e) => { e.stopPropagation(); downloadResultsAsPdf(data, item.name); }}
              className="p-2 text-slate-400 hover:text-red-600 transition-colors"
              title="Baixar em PDF"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
            </button>
            <svg className={`w-5 h-5 text-slate-400 transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7"></path></svg>
          </div>
        </div>
        
        {isExpanded && (
          <div className="p-8 border-t border-slate-100 bg-white animate-in fade-in slide-in-from-top-4 duration-500">
             <div className="text-center py-6 bg-slate-50 rounded-2xl border border-slate-100 mb-6">
                <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">Resumo do Documento</p>
                <div className="flex justify-center gap-6">
                   <div className="text-center">
                      <span className="block text-2xl font-black text-indigo-600">{Object.keys(data).length}</span>
                      <span className="text-[8px] font-black uppercase text-slate-400 tracking-tighter">Foros</span>
                   </div>
                   <div className="text-center">
                      <span className="block text-2xl font-black text-indigo-600">{totalCount}</span>
                      <span className="text-[8px] font-black uppercase text-slate-400 tracking-tighter">Processos</span>
                   </div>
                </div>
             </div>
            
            <div className="flex justify-end">
               <button 
                  onClick={() => openDetailView(data, item.name)}
                  className="text-xs font-black text-indigo-600 hover:text-indigo-700 uppercase tracking-widest flex items-center gap-2"
                  title="Abrir em Tela Cheia para Detalhes e Exportação Seletiva"
               >
                 Abrir Detalhes & Exportação
                 <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
               </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  if (view === 'home') {
    return (
      <div className="min-h-screen bg-white">
        <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-24 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-600 p-2 rounded-xl shadow-lg shadow-indigo-200">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <span className="font-black text-slate-900 text-2xl tracking-tighter">LegalFilter<span className="text-indigo-600">Pro</span></span>
          </div>
          <button onClick={() => setView('tool')} className="px-6 py-3 text-sm font-bold text-white bg-indigo-600 rounded-2xl hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100">
            Acessar Plataforma
          </button>
        </nav>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 lg:py-40 text-center">
            <h1 className="text-6xl lg:text-8xl font-black text-slate-900 mb-8 tracking-tighter leading-none">Gestão Jurídica Inteligente <span className="text-indigo-600 block">em Segundos.</span></h1>
            <p className="max-w-2xl mx-auto text-xl text-slate-500 mb-12 leading-relaxed">Extraia números de processos, identifique foros e organize PDFs com o poder da inteligência artificial generativa de alta fidelidade.</p>
            <button onClick={() => setView('tool')} className="px-12 py-5 bg-indigo-600 text-white font-black text-lg rounded-3xl hover:scale-105 transition-all shadow-2xl shadow-indigo-200 uppercase tracking-widest">Acessar Plataforma</button>
        </main>
      </div>
    );
  }

  if (view === 'detail') {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <header className="h-20 bg-white border-b border-slate-200 px-6 lg:px-12 flex items-center justify-between sticky top-0 z-10 shadow-sm">
          <div className="flex items-center gap-4">
            <button onClick={() => setView('tool')} className="p-2.5 hover:bg-slate-100 rounded-xl text-slate-500 transition-colors" title="Voltar">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
            </button>
            <div>
              <h1 className="text-xl font-black text-slate-800 tracking-tight">Análise Detalhada</h1>
              <p className="text-[10px] font-black text-indigo-600 uppercase tracking-tighter max-w-[200px] truncate">{fileName}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
             <div className="flex bg-slate-100 p-1 rounded-xl mr-4">
               <button 
                 onClick={() => setDetailTab('summary')}
                 className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${detailTab === 'summary' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
               >
                 Resumo & Exportação
               </button>
               <button 
                 onClick={() => setDetailTab('details')}
                 className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${detailTab === 'details' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
               >
                 Visualização Completa
               </button>
             </div>
            <button onClick={() => copyToClipboard(formatAllForExport(groupedData))} className="px-5 py-2.5 text-xs font-black text-slate-600 hover:bg-slate-100 rounded-xl border border-slate-200 uppercase tracking-widest transition-all">Copiar Tudo</button>
            <button onClick={() => groupedData && downloadResults(groupedData, fileName || "Análise")} className="px-5 py-2.5 bg-white text-slate-700 text-xs font-black rounded-xl border border-slate-200 hover:bg-slate-50 uppercase tracking-widest transition-all">Exportar Tudo (TXT)</button>
          </div>
        </header>

        <main className="flex-1 p-8 lg:p-12 max-w-6xl mx-auto w-full">
            {groupedData && Object.keys(groupedData).length > 0 ? (
               detailTab === 'summary' ? (
                 <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <div className="bg-white p-8 rounded-4xl border border-slate-200 shadow-sm">
                       <div className="flex justify-between items-center mb-6">
                          <div>
                             <h3 className="text-lg font-black text-slate-900 tracking-tight">Exportação por Foro</h3>
                             <p className="text-xs text-slate-400 font-medium">Selecione os tribunais que deseja incluir no seu relatório customizado.</p>
                          </div>
                          <div className="flex gap-2">
                             <button 
                                onClick={() => setSelectedForos(new Set(Object.keys(groupedData)))}
                                className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:underline"
                             >
                               Selecionar Todos
                             </button>
                             <button 
                                onClick={() => setSelectedForos(new Set())}
                                className="text-[10px] font-black text-slate-400 uppercase tracking-widest hover:underline"
                             >
                               Limpar
                             </button>
                          </div>
                       </div>
                       
                       <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                          {Object.entries(groupedData).sort((a,b) => a[0].localeCompare(b[0], 'pt-BR')).map(([foro, processos]) => (
                             <label 
                               key={foro} 
                               className={`cursor-pointer p-5 rounded-3xl border transition-all duration-300 flex flex-col gap-2 group ${selectedForos.has(foro) ? 'border-indigo-600 bg-indigo-50/50 ring-2 ring-indigo-100 shadow-md' : 'border-slate-100 bg-slate-50 hover:bg-white hover:shadow-lg'}`}
                             >
                                <div className="flex justify-between items-start">
                                   <input 
                                     type="checkbox" 
                                     checked={selectedForos.has(foro)}
                                     onChange={() => toggleForoSelection(foro)}
                                     className="w-5 h-5 text-indigo-600 rounded-lg border-slate-300 focus:ring-indigo-500 transition-all"
                                   />
                                   <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${selectedForos.has(foro) ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-500'}`}>
                                      {processos.length}
                                   </span>
                                </div>
                                <span className={`text-sm font-black uppercase tracking-tight group-hover:text-indigo-900 transition-colors ${selectedForos.has(foro) ? 'text-indigo-900' : 'text-slate-700'}`}>
                                   {foro}
                                </span>
                             </label>
                          ))}
                       </div>

                       {selectedForos.size > 0 && (
                          <div className="mt-12 pt-8 border-t border-slate-100 flex flex-col md:flex-row items-center justify-between gap-6">
                             <div className="text-center md:text-left">
                                <span className="text-xs font-black text-indigo-600 uppercase tracking-widest block">{selectedForos.size} FOROS SELECIONADOS</span>
                                <span className="text-[10px] text-slate-400 font-medium">Os arquivos conterão apenas os processos dos tribunais marcados acima.</span>
                             </div>
                             <div className="flex gap-4">
                                <button 
                                  onClick={() => downloadResults(groupedData, fileName || "Análise", selectedForos)}
                                  className="px-8 py-3 bg-white text-slate-700 text-xs font-black rounded-2xl border border-slate-200 hover:bg-slate-50 uppercase tracking-widest transition-all shadow-sm flex items-center gap-2"
                                >
                                   <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                                   Exportar TXT
                                </button>
                                <button 
                                  onClick={() => downloadResultsAsPdf(groupedData, fileName || "Análise", selectedForos)}
                                  className="px-8 py-3 bg-indigo-600 text-white text-xs font-black rounded-2xl hover:bg-indigo-700 shadow-xl shadow-indigo-100 uppercase tracking-widest transition-all flex items-center gap-2"
                                >
                                   <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                                   Gerar Relatório PDF
                                </button>
                             </div>
                          </div>
                       )}
                    </div>
                 </div>
               ) : (
                 <div className="grid gap-8 sm:grid-cols-1 md:grid-cols-2 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    {Object.entries(groupedData).sort((a,b) => a[0].localeCompare(b[0], 'pt-BR')).map(([foro, processos]) => (
                      <div key={foro} className="bg-white rounded-4xl shadow-sm border border-slate-200 overflow-hidden flex flex-col hover:shadow-2xl transition-all duration-300">
                        <div className="bg-slate-50/80 px-8 py-6 border-b border-slate-200 flex justify-between items-center">
                          <h3 className="font-black text-slate-900 text-lg uppercase tracking-tight">{foro}</h3>
                          <span className="bg-white text-indigo-600 text-[10px] font-black px-3 py-1.5 rounded-full border border-indigo-100 shadow-sm">{processos.length} ITENS</span>
                        </div>
                        <div className="p-8 flex-1">
                          <ul className="space-y-3">
                            {processos.map((p, idx) => (
                              <li key={idx} className="flex items-center justify-between group p-4 bg-slate-50/40 hover:bg-indigo-50/50 rounded-2xl transition-all border border-transparent hover:border-indigo-100">
                                <code className="text-indigo-600 font-mono text-sm font-bold tracking-tight">{p}</code>
                                <button onClick={() => copyToClipboard(p)} className="p-2 text-slate-300 hover:text-indigo-600 transition-colors" title="Copiar Processo">
                                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    ))}
                 </div>
               )
            ) : (
              <div className="col-span-full flex flex-col items-center justify-center py-20 text-slate-400">
                <svg className="w-16 h-16 mb-4 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9.172 9.172a4 4 0 015.656 0M9 10h.01M15 10h.01M12 12h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                <p className="text-xl font-medium">Nenhum processo encontrado para exibição.</p>
              </div>
            )}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex overflow-hidden">
      <aside className="w-85 bg-white border-r border-slate-200 flex flex-col hidden lg:flex">
        <div className="p-6 border-b border-slate-100">
          <div className="flex items-center gap-2 mb-6">
            <div className="bg-indigo-600 p-1.5 rounded-lg shadow-md">
              <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            </div>
            <span className="font-black text-slate-900 text-lg tracking-tighter">LegalFilter<span className="text-indigo-600">Pro</span></span>
          </div>
          <div className="flex gap-1 bg-slate-100 p-1 rounded-xl">
            <button onClick={() => setSidebarTab('workspace')} className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${sidebarTab === 'workspace' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>Área de Trabalho</button>
            <button onClick={() => setSidebarTab('history')} className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${sidebarTab === 'history' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>Histórico</button>
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {sidebarTab === 'workspace' ? (
            workspace.length === 0 ? (
              <div className="text-center py-20 opacity-30 flex flex-col items-center">
                <svg className="w-12 h-12 mb-2 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
                <p className="text-[10px] font-black uppercase tracking-widest">Workspace Vazio</p>
              </div>
            ) : (
              <>
                <div className="px-2 pb-4 pt-1 space-y-3 border-b border-slate-100 mb-4">
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={analyzeBatchSequential}
                      disabled={isSequentialRunning || workspace.filter(f => f.selected && f.status !== 'completed').length === 0}
                      className="flex-1 py-3 bg-indigo-600 text-white text-[10px] font-black rounded-xl hover:bg-indigo-700 uppercase tracking-widest transition-all shadow-lg shadow-indigo-100 disabled:bg-slate-200 disabled:shadow-none flex items-center justify-center gap-2"
                      title="Analisar os itens selecionados sequencialmente"
                    >
                      {isSequentialRunning ? (
                        <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      ) : (
                        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                      )}
                      {isSequentialRunning ? 'Processando Lote...' : 'Análise Automática'}
                    </button>
                  </div>
                  <div className="flex justify-between items-center px-2">
                    <button 
                      onClick={toggleAllSelection} 
                      className="text-[9px] font-black text-indigo-600 uppercase tracking-widest hover:text-indigo-800 transition-colors"
                    >
                      {workspace.filter(f => f.status !== 'completed').every(f => f.selected) ? 'Desmarcar Pendentes' : 'Selecionar Pendentes'}
                    </button>
                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                      {workspace.filter(f => f.selected).length} de {workspace.filter(f => f.status !== 'completed').length} pendentes
                    </span>
                  </div>
                </div>
                {workspace.map(file => (
                  <SidebarCard 
                    key={file.id}
                    title={file.name}
                    subtitle={`${file.pageCount} páginas`}
                    selected={file.selected}
                    isCompleted={file.status === 'completed'}
                    onToggleSelect={() => toggleFileSelection(file.id)}
                    status={file.status === 'processing' ? 'Analizando...' : (file.status === 'completed' ? 'Finalizado' : (file.status === 'error' ? 'Erro' : 'Aguardando'))}
                    statusColor={file.status === 'processing' ? 'bg-indigo-50 text-indigo-600' : (file.status === 'completed' ? 'bg-green-50 text-green-600' : (file.status === 'error' ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-400'))}
                    actions={
                      <>
                        {file.status === 'processing' ? (
                          <button onClick={() => stopAnalysis(file.id)} className="flex-1 py-2 bg-red-50 text-red-600 text-[10px] font-black rounded-xl hover:bg-red-100 uppercase tracking-widest transition-all" title="Parar Análise">Parar</button>
                        ) : file.status !== 'completed' ? (
                          <button onClick={() => analyzeWorkspaceFile(file)} className="flex-1 py-2 bg-indigo-600 text-white text-[10px] font-black rounded-xl hover:bg-indigo-700 uppercase tracking-widest transition-all" title="Analisar Individualmente">Analisar</button>
                        ) : null}
                        
                        <button onClick={() => downloadBlob(file.blob, file.name)} className="p-2 border border-slate-200 rounded-xl hover:bg-white text-slate-400 hover:text-indigo-600 transition-all" title="Baixar PDF Original"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg></button>
                        
                        {file.status === 'completed' && file.results && (
                          <div className="flex gap-2 w-full mt-2">
                            <button onClick={() => openDetailView(file.results!, file.name)} className="flex-1 p-2 bg-indigo-50 border border-indigo-100 rounded-xl text-indigo-600 hover:bg-indigo-100 transition-all flex justify-center" title="Ver Resultados e Exportação">
                               <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                            </button>
                            <button onClick={() => downloadResults(file.results!, file.name)} className="p-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-500 hover:bg-slate-100 transition-all" title="Baixar Resultados (TXT)">
                               <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                            </button>
                            <button onClick={() => downloadResultsAsPdf(file.results!, file.name)} className="p-2 bg-red-50 border border-red-100 rounded-xl text-red-500 hover:bg-red-100 transition-all" title="Baixar Análise (PDF)">
                               <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                            </button>
                          </div>
                        )}
                      </>
                    }
                  />
                ))}
              </>
            )
          ) : (
            <div className="space-y-4">
              {history.length > 0 && (
                 <button 
                  onClick={exportAllHistory}
                  className="w-full py-3 bg-slate-900 text-white text-[10px] font-black rounded-xl hover:bg-black uppercase tracking-widest transition-all mb-4 flex items-center justify-center gap-2 shadow-lg shadow-slate-200"
                  title="Exportar todas as buscas realizadas em um único TXT"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                  Exportar Histórico Completo
                </button>
              )}
              {history.length === 0 ? (
                 <div className="text-center py-20 opacity-30 flex flex-col items-center">
                  <svg className="w-12 h-12 mb-2 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                  <p className="text-[10px] font-black uppercase tracking-widest">Sem Histórico</p>
                </div>
              ) : (
                history.map(item => (
                  <SidebarCard 
                    key={item.id}
                    title={item.name}
                    subtitle={new Date(item.timestamp).toLocaleString('pt-BR')}
                    actions={
                      <div className="flex flex-col gap-2 w-full">
                        <button 
                          onClick={() => openDetailView(item.results, item.name)}
                          className="w-full py-2 bg-indigo-50 text-indigo-600 text-[10px] font-black rounded-xl hover:bg-indigo-100 flex items-center justify-center gap-1.5 uppercase tracking-widest transition-all"
                        >
                          Visualizar & Exportar
                        </button>
                        <div className="flex gap-2">
                           <button onClick={() => downloadResults(item.results, item.name)} className="flex-1 p-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-500 hover:bg-slate-100 transition-all flex justify-center" title="Baixar Resultados (TXT)">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                           </button>
                           <button onClick={() => downloadResultsAsPdf(item.results, item.name)} className="flex-1 p-2 bg-red-50 border border-red-100 rounded-xl text-red-500 hover:bg-red-100 transition-all flex justify-center" title="Baixar Análise (PDF)">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                           </button>
                        </div>
                      </div>
                    }
                  />
                ))
              )}
            </div>
          )}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-20 bg-white border-b border-slate-200 px-8 flex items-center justify-between shadow-sm flex-shrink-0">
          <div className="flex items-center gap-6">
            <button onClick={() => setView('home')} className="p-2.5 bg-slate-100 text-slate-400 hover:text-indigo-600 rounded-xl transition-all" title="Ir para Home"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path></svg></button>
            <div className="flex gap-1 bg-slate-100 p-1.5 rounded-2xl overflow-x-auto no-scrollbar">
              <button onClick={() => setToolMode('extract')} className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all whitespace-nowrap ${toolMode === 'extract' ? 'bg-white text-indigo-600 shadow-md' : 'text-slate-400 hover:text-slate-600'}`}>Extração</button>
              <button onClick={() => setToolMode('ocr')} className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all whitespace-nowrap ${toolMode === 'ocr' ? 'bg-white text-indigo-600 shadow-md' : 'text-slate-400 hover:text-slate-600'}`}>OCR Modality</button>
              <button onClick={() => setToolMode('split')} className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all whitespace-nowrap ${toolMode === 'split' ? 'bg-white text-indigo-600 shadow-md' : 'text-slate-400 hover:text-slate-600'}`}>Divisor</button>
              <button onClick={() => setToolMode('consolidated')} className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all whitespace-nowrap ${toolMode === 'consolidated' ? 'bg-white text-indigo-600 shadow-md' : 'text-slate-400 hover:text-slate-600'}`}>Análise Detalhada</button>
            </div>
          </div>
          <button 
            onClick={() => { if(confirm("Limpar todo o histórico?")) { setHistory([]); setExpandedResults({}); } }}
            className="text-[10px] font-black text-slate-300 hover:text-red-500 uppercase tracking-widest transition-colors"
          >
            Limpar Histórico
          </button>
        </header>

        <main className="flex-1 overflow-y-auto p-8 lg:p-12 max-w-5xl mx-auto w-full space-y-10">
          {toolMode === 'consolidated' ? (
             <div className="space-y-8 animate-in fade-in zoom-in-95 duration-500">
                <section className="bg-white rounded-4xl p-10 border border-slate-100 shadow-2xl">
                   <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
                      <div>
                        <h2 className="text-3xl font-black text-slate-900 mb-2 tracking-tight">Gestão Global de Foros</h2>
                        <p className="text-slate-400 text-sm">Aqui estão todos os tribunais encontrados em suas análises. Selecione e exporte em massa.</p>
                      </div>
                      <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-xl w-fit self-start md:self-auto">
                         <button 
                            onClick={() => setForoSortOrder('asc')}
                            className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all flex items-center gap-2 ${foroSortOrder === 'asc' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                            title="Ordem Alfabética Crescente"
                         >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"></path></svg>
                            A-Z
                         </button>
                         <button 
                            onClick={() => setForoSortOrder('desc')}
                            className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all flex items-center gap-2 ${foroSortOrder === 'desc' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                            title="Ordem Alfabética Decrescente"
                         >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M3 4h13M3 8h9m-9 4h6m4 0l4 4m0 0l-4-4m4 4v-12"></path></svg>
                            Z-A
                         </button>
                      </div>
                   </div>
                   
                   {sortedGlobalForos.length === 0 ? (
                      <div className="py-20 text-center opacity-20">
                         <svg className="w-20 h-20 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                         <p className="text-xl font-black uppercase tracking-widest">Nenhuma análise disponível</p>
                      </div>
                   ) : (
                      <>
                         <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
                            {sortedGlobalForos.map(([foro, data]) => (
                               <label 
                                  key={foro} 
                                  className={`p-6 rounded-3xl border cursor-pointer transition-all duration-300 animate-in fade-in slide-in-from-bottom-2 ${consolidatedSelection.has(foro) ? 'border-indigo-600 bg-indigo-50 shadow-lg ring-2 ring-indigo-100' : 'border-slate-100 bg-slate-50 hover:bg-white hover:shadow-xl'}`}
                               >
                                  <div className="flex justify-between items-start mb-4">
                                     <input 
                                        type="checkbox" 
                                        checked={consolidatedSelection.has(foro)}
                                        onChange={() => toggleConsolidatedSelection(foro)}
                                        className="w-5 h-5 text-indigo-600 rounded-lg border-slate-300 transition-all"
                                     />
                                     <span className="text-[10px] font-black bg-white px-2.5 py-1 rounded-full border border-slate-200 text-indigo-600">{data.procesos.size} processos</span>
                                  </div>
                                  <h4 className="font-black text-slate-900 uppercase tracking-tight truncate">{foro}</h4>
                                  <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mt-1">Presente em {data.docs.size} arquivos</p>
                               </label>
                            ))}
                         </div>
                         
                         {consolidatedSelection.size > 0 && (
                            <div className="mt-12 flex items-center justify-between p-8 bg-indigo-900 rounded-4xl text-white animate-in slide-in-from-bottom-8">
                               <div>
                                  <p className="text-xs font-black uppercase tracking-widest opacity-60">Seleção Consolidada</p>
                                  <h3 className="text-xl font-black">{consolidatedSelection.size} Tribunais Selecionados</h3>
                               </div>
                               <div className="flex gap-4">
                                  <button onClick={() => downloadConsolidatedSelection('txt')} className="px-6 py-3 bg-white/10 hover:bg-white/20 text-white text-xs font-black rounded-2xl transition-all uppercase tracking-widest border border-white/20">Baixar TXT</button>
                                  <button onClick={() => downloadConsolidatedSelection('pdf')} className="px-8 py-3 bg-white text-indigo-900 text-xs font-black rounded-2xl hover:scale-105 transition-all uppercase tracking-widest shadow-xl">Gerar Relatório PDF</button>
                               </div>
                            </div>
                         )}
                      </>
                   )}
                </section>
             </div>
          ) : (
            <>
              <section className="bg-white rounded-4xl shadow-2xl shadow-slate-200/50 border border-slate-100 p-10 flex flex-col items-center">
                <div className="w-full text-center">
                  <h2 className="text-3xl font-black text-slate-900 mb-2 tracking-tight">
                    {toolMode === 'extract' ? 'Análise Documental IA' : 
                     toolMode === 'ocr' ? 'OCR Multimodal (Imagem ou PDF)' :
                     'Divisão de Documentos'}
                  </h2>
                  <p className="text-slate-400 text-sm mb-10 max-w-md mx-auto">
                    {toolMode === 'ocr' ? 'Upload de Imagens ou PDFs digitalizados para reconhecimento visual e extração de processos.' : 'Upload de PDFs para processamento jurídico especializado com Gemini 3 Pro.'}
                  </p>
                  
                  {(toolMode === 'extract' || toolMode === 'ocr') && (
                    <div className="mb-8 text-left">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-3 ml-2">Lista de Processos para Filtro (Opcional)</label>
                      <textarea 
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Cole os números de processo (um por linha ou separados por vírgula) para filtrar a extração."
                        className="w-full h-28 p-5 bg-slate-50 border border-slate-100 rounded-3xl text-sm text-slate-700 focus:ring-4 focus:ring-indigo-100 focus:bg-white focus:border-indigo-400 transition-all outline-none resize-none font-mono placeholder:text-slate-300 shadow-inner"
                      />
                    </div>
                  )}

                  <label className="flex flex-col items-center justify-center w-full h-56 border-3 border-slate-100 border-dashed rounded-4xl cursor-pointer bg-slate-50 hover:bg-slate-100 hover:border-indigo-300 group transition-all">
                    <div className="flex flex-col items-center justify-center">
                      <div className="p-4 bg-white rounded-2xl shadow-sm mb-4 group-hover:scale-110 group-hover:shadow-lg transition-all duration-300">
                        <svg className="w-10 h-10 text-slate-300 group-hover:text-indigo-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                      </div>
                      <p className="text-sm font-bold text-slate-600"><span className="text-indigo-600">{toolMode === 'ocr' ? 'Arraste sua Imagem ou PDF aqui' : 'Arraste seu PDF jurídico aqui'}</span> ou navegue</p>
                      <p className="text-[10px] text-slate-300 font-bold uppercase tracking-widest mt-2 italic">Formatos suportados: {toolMode === 'ocr' ? 'JPG, JPEG, PNG, PDF' : 'PDF nativo ou digitalizado'}</p>
                    </div>
                    <input type="file" className="hidden" accept={toolMode === 'ocr' ? 'image/*,application/pdf' : '.pdf'} onChange={handleFileUpload} />
                  </label>
                  
                  {fileName && !loading && (
                    <div className="mt-4 flex items-center justify-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                      <p className="text-xs font-black text-slate-600 uppercase tracking-tighter truncate max-w-xs">{fileName}</p>
                    </div>
                  )}

                  {toolMode === 'split' && totalPages !== null && (
                    <div className="mt-10 pt-10 border-t border-slate-50 flex flex-col md:flex-row items-center justify-center gap-10">
                      <div className="text-center md:text-left">
                        <label className="text-[10px] font-black text-slate-300 uppercase tracking-widest mb-1 block">Total de Páginas</label>
                        <span className="text-4xl font-black text-slate-900 tracking-tighter">{totalPages}</span>
                      </div>
                      <div className="h-12 w-px bg-slate-100 hidden md:block"></div>
                      <div className="text-center md:text-left">
                        <label className="text-[10px] font-black text-slate-300 uppercase tracking-widest mb-1 block">Páginas por Bloco</label>
                        <input 
                          type="number" 
                          min="1" 
                          max={totalPages} 
                          value={pagesPerPart} 
                          onChange={(e) => setPagesPerPart(parseInt(e.target.value) || 1)} 
                          className="w-28 bg-slate-50 border border-slate-100 rounded-2xl px-5 py-3 font-black text-slate-900 focus:ring-4 focus:ring-indigo-100 text-center text-xl transition-all" 
                        />
                      </div>
                      <button onClick={handleSplit} disabled={loading} className="px-10 py-4 bg-indigo-600 text-white font-black rounded-2xl shadow-xl shadow-indigo-100 hover:bg-indigo-700 hover:-translate-y-1 transition-all disabled:bg-slate-200 uppercase tracking-widest">Gerar Divisões</button>
                    </div>
                  )}
                </div>
              </section>

              {loading && (
                <div className="bg-white rounded-3xl p-10 border border-slate-100 shadow-2xl flex flex-col items-center gap-6 animate-in zoom-in-95 duration-300">
                  <div className="relative">
                    <div className="animate-spin rounded-full h-24 w-24 border-4 border-indigo-100 border-t-indigo-600"></div>
                    <div className="absolute inset-0 flex items-center justify-center text-xs font-black text-indigo-600">
                      {progress.phase === 'extracting' 
                        ? (progress.total > 0 ? `${Math.round((progress.current / progress.total) * 100)}%` : '...') 
                        : `${simulatedProgress}%`}
                    </div>
                  </div>
                  <div className="text-center">
                    <p className="text-xs font-black text-indigo-600 uppercase tracking-widest mb-1">
                      {progress.phase === 'extracting' ? 'Extração de Conteúdo' : 'Análise Visual Gemini IA'}
                    </p>
                    <p className="text-sm font-black text-slate-800 tracking-tight">
                       {progress.phase === 'extracting' ? 'Processando extração de texto...' : 'Identificando processos e tribunais visualmente...'}
                    </p>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-3 flex flex-col gap-1.5">
                      <span className="truncate max-w-[300px] font-black text-indigo-600">{fileName}</span>
                      <span className="text-slate-500 font-black animate-pulse">{calculateRemainingTime()}</span>
                    </p>
                  </div>
                  <div className="w-full max-w-md bg-slate-100 h-2.5 rounded-full overflow-hidden shadow-inner border border-slate-100">
                     <div 
                       className="h-full bg-gradient-to-r from-indigo-500 to-indigo-700 transition-all duration-300 ease-out shadow-lg" 
                       style={{width: progress.phase === 'extracting' 
                         ? (progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : '5%')
                         : `${simulatedProgress}%`
                       }}
                     />
                  </div>
                  <button onClick={() => stopAnalysis('direct_upload')} className="px-8 py-2.5 bg-red-50 text-red-600 text-[10px] font-black rounded-xl hover:bg-red-100 transition-all border border-red-100 uppercase tracking-widest">Interromper Processo</button>
                </div>
              )}

              {error && <div className="bg-red-50 border border-red-100 p-8 rounded-3xl flex items-center gap-4 text-red-600 text-sm font-bold shadow-sm animate-in shake duration-500">{error}</div>}

              {!loading && history.length > 0 && (
                <div className="space-y-6">
                   <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest ml-2">Resultados Recentes</h3>
                   {history.slice(0, 10).map(item => (
                      <ResultsAccordion key={item.id} item={item} />
                   ))}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
};

export default App;
