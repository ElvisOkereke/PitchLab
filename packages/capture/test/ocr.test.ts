import { dedupeLines, tesseractOcr } from '../src/ocr';

describe('dedupeLines', () => {
  it('keeps the first spelling, ignores case and spacing, drops blanks and stray single characters', () => {
    expect(dedupeLines(['Line A\n  line   a \n\n|', 'LINE A\nPrice: $29', 'Price:  $29\nNew line'])).toEqual(['Line A', 'Price: $29', 'New line']);
  });
});

describe('tesseractOcr', () => {
  it('loads tesseract.js lazily, reads every image with one worker and terminates it', async () => {
    const recognize = vi.fn(async (p: string) => ({ data: { text: `text of ${p}` } }));
    const terminate = vi.fn(async () => {});
    const createWorker = vi.fn(async () => ({ recognize, terminate }));
    const importer = vi.fn(async () => ({ createWorker }));
    const ocr = tesseractOcr({ importer });
    expect(importer).not.toHaveBeenCalled();
    expect(await ocr(['a.png', 'b.png'])).toEqual(['text of a.png', 'text of b.png']);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates the worker even when recognition fails', async () => {
    const terminate = vi.fn(async () => {});
    const importer = async () => ({
      default: { createWorker: async () => ({ recognize: async () => Promise.reject(new Error('bad image')), terminate }) },
    });
    await expect(tesseractOcr({ importer })(['a.png'])).rejects.toThrow('bad image');
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
