import { DoctorPanel } from '../../components/doctor/DoctorPanel';

export type { DoctorCheckResult } from '../../components/doctor/DoctorPanel';

/** SwarmKit package diagnostics — an instance of the generic DoctorPanel. */
export function SwarmKitDoctor({
  projectRoot,
}: {
  projectRoot: string | null;
}) {
  return (
    <DoctorPanel
      endpoint={
        projectRoot
          ? `/admin/swarmkit/doctor?projectRoot=${encodeURIComponent(projectRoot)}`
          : '/admin/swarmkit/doctor'
      }
      queryKey={['swarmkit-doctor', projectRoot]}
      title="Health Check"
    />
  );
}
