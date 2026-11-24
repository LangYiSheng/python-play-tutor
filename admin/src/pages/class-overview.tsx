import type { Classroom } from "@/lib/types";
import { PageHeader } from "@/components/common";
export function ClassOverview({classroom}: {classroom: Classroom}) {
  return <><PageHeader title={classroom.name}/><section className="surface p-6"><h2>班级加入码</h2>
    <p className="join-code">{classroom.join_code}</p><p>学生也可以由教师从学生名册导入。</p>
  </section></>;
}
