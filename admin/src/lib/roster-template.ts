import { download, errorMessage, fileBlob } from "./api";
import { toast } from "@/components/ui/toast";

export async function downloadRosterTemplate(fmt: "xlsx" | "csv" = "xlsx"): Promise<void> {
  try {
    const blob = await fileBlob(`/teacher/roster-template?fmt=${fmt}`);
    download(blob, `学生名册导入模板.${fmt}`);
  } catch (err) {
    toast.add({ title: errorMessage(err), type: "error" });
  }
}
