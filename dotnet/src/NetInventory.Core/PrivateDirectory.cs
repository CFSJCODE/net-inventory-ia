using System.Security.AccessControl;
using System.Security.Principal;

namespace NetInventory.Core;

public static class PrivateDirectory
{
    public static string Create(string path, string? allowedUserSid = null)
    {
        path = Path.GetFullPath(path);
        var directory = Directory.CreateDirectory(path);
        if (OperatingSystem.IsWindows())
        {
            var acl = new DirectorySecurity();
            acl.SetAccessRuleProtection(true, false);
            var inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            var managedRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "NetInventoryDotNet");
            var managed = path.Equals(managedRoot, StringComparison.OrdinalIgnoreCase) || path.StartsWith(managedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
            var principals = managed ? new[] { system, administrators } : new[] { WindowsIdentity.GetCurrent().User!, system, administrators };
            foreach (var sid in principals)
                acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            if (managed) acl.SetOwner(administrators);
            else if (!string.IsNullOrWhiteSpace(allowedUserSid)) acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(allowedUserSid), FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            directory.SetAccessControl(acl);
        }
        else File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        return path;
    }
}
