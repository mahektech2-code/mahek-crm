package expo.modules.pdfpreview

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream

/**
 * A PDF PAGE, DRAWN AS A PICTURE, ON THE PHONE THAT HOLDS THE FILE.
 *
 * The library used to hand every document to "whatever on the phone opens
 * PDFs", and a salesman's phone frequently has nothing that does — or has
 * something, but the file was saved with no extension and went over with no
 * type, so Android matched it to nothing and the tap did nothing he could see.
 *
 * Android has had `PdfRenderer` since API 21. It needs no library, no network
 * and no other app, which is exactly what a price list opened in a market with
 * no signal needs. It draws one page into a bitmap; this writes that bitmap to
 * the cache and returns where, and the screen shows it as an image.
 *
 * **One renderer at a time.** `PdfRenderer` allows one open page per renderer
 * and is not thread-safe, and the screen asks for several pages as they scroll
 * into view — so every call is serialised on `lock` and opens, draws and
 * closes in one go. A page is a few tens of milliseconds; a queue of them is
 * not worth a second open file to save.
 *
 * **The drawn pages live in the CACHE directory on purpose**: Android empties
 * it when storage runs low, and a page is always redrawable from the PDF,
 * which lives in the documents directory and is never swept.
 *
 * **A page is drawn once per width.** The file name is the source's path, its
 * size and modification time, the page and the width, so a replaced document
 * never shows last month's page and a page scrolled past twice is read back
 * from disk rather than redrawn.
 */
class PdfPreviewModule : Module() {
  private val lock = Any()

  /* The largest page we will allocate, in pixels. 4096 x 4096 is 64 MB of
     ARGB — enough for a zoomed A4 page at well over print resolution, and
     well short of what kills a low-end phone. */
  private val maxPixels = 4096L * 4096L

  override fun definition() = ModuleDefinition {
    Name("MbosPdfPreview")

    AsyncFunction("pageCount") { uri: String ->
      synchronized(lock) {
        open(uri).use { it.renderer.pageCount }
      }
    }

    AsyncFunction("renderPage") { uri: String, index: Int, widthPx: Int ->
      synchronized(lock) {
        val source = fileOf(uri)
        open(uri).use { doc ->
          if (index < 0 || index >= doc.renderer.pageCount) {
            throw CodedException("ERR_PAGE", "There is no page ${index + 1} in this file.", null)
          }
          doc.renderer.openPage(index).use { page ->
            var width = widthPx.coerceIn(64, 4096)
            var height = Math.max(1, Math.round(width.toDouble() * page.height / page.width).toInt())
            if (width.toLong() * height > maxPixels) {
              val scale = Math.sqrt(maxPixels.toDouble() / (width.toLong() * height))
              width = Math.max(1, (width * scale).toInt())
              height = Math.max(1, (height * scale).toInt())
            }

            val cacheDir = File(appContext.reactContext?.cacheDir ?: throw CodedException("ERR_CONTEXT", "The app is not ready.", null), "pdf-preview")
            cacheDir.mkdirs()
            val key = "${source.absolutePath}|${source.length()}|${source.lastModified()}".hashCode().toUInt().toString(16)
            val out = File(cacheDir, "$key-$index-$width.png")
            if (!out.exists() || out.length() == 0L) {
              val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
              try {
                // A PDF page is transparent where nothing is printed, and a
                // transparent page on a grey viewer reads as a grey page.
                bitmap.eraseColor(Color.WHITE)
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                val partial = File(cacheDir, out.name + ".part")
                FileOutputStream(partial).use { stream -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream) }
                partial.renameTo(out)
              } finally {
                bitmap.recycle()
              }
            }
            mapOf("uri" to Uri.fromFile(out).toString(), "width" to width, "height" to height)
          }
        }
      }
    }
  }

  private class OpenDocument(val fd: ParcelFileDescriptor, val renderer: PdfRenderer) : AutoCloseable {
    override fun close() {
      renderer.close()
      fd.close()
    }
  }

  private fun fileOf(uri: String): File {
    val path = if (uri.startsWith("file:")) Uri.parse(uri).path else uri
    if (path.isNullOrEmpty()) throw CodedException("ERR_FILE", "That is not a file on this phone.", null)
    return File(path)
  }

  private fun open(uri: String): OpenDocument {
    val file = fileOf(uri)
    if (!file.exists()) throw CodedException("ERR_FILE", "The file is no longer on this phone.", null)
    val fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    return try {
      OpenDocument(fd, PdfRenderer(fd))
    } catch (e: Exception) {
      fd.close()
      // A password-protected PDF throws SecurityException; a damaged one,
      // IOException. Both mean the same thing to the person holding the phone.
      throw CodedException("ERR_UNREADABLE", "This PDF cannot be drawn here — it may be locked with a password.", e)
    }
  }
}
