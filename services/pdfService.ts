
import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs';
import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1';

// @ts-ignore
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';

export type ProgressCallback = (current: number, total: number) => void;

export const extractTextFromPdf = async (
  file: File | Blob, 
  onProgress?: ProgressCallback
): Promise<string> => {
  const arrayBuffer = await file.arrayBuffer();
  // @ts-ignore
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  let fullText = '';

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: any) => item.str)
      .join(' ');
    
    fullText += pageText + '\n';
    
    if (onProgress) {
      onProgress(i, numPages);
    }
  }

  return fullText;
};

export const getPageCount = async (file: File | Blob): Promise<number> => {
  const arrayBuffer = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  return pdfDoc.getPageCount();
};

export const splitPdf = async (file: File | Blob, pagesPerPart: number): Promise<{name: string, blob: Blob, pageCount: number}[]> => {
  const arrayBuffer = await file.arrayBuffer();
  const mainPdfDoc = await PDFDocument.load(arrayBuffer);
  const totalPages = mainPdfDoc.getPageCount();
  const parts = [];

  for (let i = 0; i < totalPages; i += pagesPerPart) {
    const newPdfDoc = await PDFDocument.create();
    const endPage = Math.min(i + pagesPerPart, totalPages);
    
    const pagesToCopy = Array.from({ length: endPage - i }, (_, index) => i + index);
    const copiedPages = await newPdfDoc.copyPages(mainPdfDoc, pagesToCopy);
    
    copiedPages.forEach(page => newPdfDoc.addPage(page));
    
    const pdfBytes = await newPdfDoc.save();
    parts.push({
      name: `Parte ${parts.length + 1} (Págs ${i + 1}-${endPage})`,
      blob: new Blob([pdfBytes], { type: 'application/pdf' }),
      pageCount: endPage - i
    });
  }

  return parts;
};
