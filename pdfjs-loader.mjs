// 把本地化的 pdf.js 暴露到全局（独立文件是为了满足 CSP：不允许内联脚本）
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';
window.pdfjsLib = pdfjsLib;
